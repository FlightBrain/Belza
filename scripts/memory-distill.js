// Runs daily from .github/workflows/memory-distill.yml (GitHub Actions).
// Reads new messages off the sdr-playersonly ambient channel log (written in
// real time by api/slack-events.js), asks an LLM to pull out (a) life events
// - people who left, got promoted, changed roles - and (b) new banter-worthy
// notes per person, then merges both into that person's profile in KV via
// mergeChannelIntel. Keeping this off the request path means ambient
// messages themselves never pay an LLM-latency cost.

import fs from 'fs';
import path from 'path';
import { getChannelLogSince } from '../lib/channel-log.js';
import { getKnownUsers, mergeChannelIntel } from '../lib/user-profiles.js';

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C093Z82DK18';
const STATE_PATH = path.join('automation', 'memory-distill-state.json');
const AUDIT_DIR = path.join('automation', 'memory-distill');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastProcessedTs: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function buildTranscript(entries) {
  return entries
    .map((e) => {
      const date = e.timestamp ? new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'unknown date';
      return `[${date}] ${e.displayName || e.userId || 'someone'}: ${e.message}`;
    })
    .join('\n');
}

// Never phrase anything as a firing - departures (fired, laid off, quit,
// whatever) are always neutral "left the company" language. Terminations
// are facts to know, not banter material.
const SYSTEM_PROMPT = `you read a Slack channel transcript from a sales team's internal group chat and extract durable facts about the PEOPLE in it, for a team bot's long-term memory.

extract two things:
1. life events: someone left the company, got promoted, or changed role. ALWAYS phrase departures neutrally - "left the company" or "moved on" - regardless of the real reason (fired, laid off, quit, whatever was actually said). NEVER use the word "fired" or anything that reads as mocking someone's departure. Promotions/new roles should just state the fact plainly.
2. notes: short, specific, banter-worthy facts about a person (running jokes, interests, things they're known for) in the same terse style you'd use to brief a friend before they hang out with this person. Skip anything mundane or already-obvious from normal work chat.

respond with ONLY a JSON object, no other text:
{"people": [{"name": "<display name as it appears in the transcript>", "lifeEvents": [{"type": "left"|"promoted"|"new_role"|"other", "note": "<short neutral fact>", "date": "<Mon DD, or empty>"}], "notes": ["<short note>", ...]}]}

only include a person if you found something concrete about them. if there's nothing worth extracting, respond {"people": []}.`;

async function classify(transcript) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`groq error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const content = data.choices?.[0]?.message?.content ?? '{"people": []}';
  const match = content.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : content);
    return Array.isArray(parsed.people) ? parsed.people : [];
  } catch {
    return [];
  }
}

function resolveUserId(name, knownUsers) {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  const hit = knownUsers.find((u) => (u.displayName || '').trim().toLowerCase() === lower);
  return hit?.userId || null;
}

async function main() {
  const state = loadState();
  const entries = await getChannelLogSince(CHANNEL_ID, state.lastProcessedTs);

  if (entries.length === 0) {
    console.log('memory-distill: no new messages since last run');
    return;
  }

  const transcript = buildTranscript(entries);
  const knownUsers = await getKnownUsers();

  let people = [];
  try {
    people = await classify(transcript);
  } catch (e) {
    console.error(`memory-distill: classify failed: ${e.message}`);
    return; // leave checkpoint alone, retry next run
  }

  const audit = { runAt: new Date().toISOString(), messagesScanned: entries.length, extracted: [] };

  for (const person of people) {
    const userId = resolveUserId(person.name, knownUsers);
    if (!userId) {
      console.log(`memory-distill: could not resolve "${person.name}" to a known user, skipping`);
      continue;
    }
    await mergeChannelIntel(userId, {
      lifeEvents: person.lifeEvents || [],
      notes: person.notes || [],
    });
    audit.extracted.push({ name: person.name, userId, lifeEvents: person.lifeEvents || [], notes: person.notes || [] });
    console.log(`memory-distill: merged intel for ${person.name} (${userId})`);
  }

  if (audit.extracted.length > 0) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const fileName = `${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(path.join(AUDIT_DIR, fileName), JSON.stringify(audit, null, 2) + '\n');
  }

  state.lastProcessedTs = entries[entries.length - 1].ts || state.lastProcessedTs;
  saveState(state);

  console.log(`memory-distill: scan complete. ${entries.length} messages scanned, ${audit.extracted.length} people updated`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
