// Runs on a schedule from .github/workflows/feedback-watch.yml (GitHub Actions,
// not Vercel — the Vercel Hobby plan caps cron at once/day per job, too coarse
// for 10-minute idle detection). Polls Braintrust for Slack conversations that
// have gone quiet for 10+ minutes, classifies whether the user gave the bot
// corrective feedback during them, and drops actionable ones into
// automation/feedback-queue/ for the Belza-feedback-fixer cloud routine to pick up.

import fs from 'fs';
import path from 'path';

const PROJECT_ID = 'f1bdafc5-2b7c-44c7-bb79-161dc87bf362'; // Braintrust project "Belza"
const IDLE_MINUTES = 10;
const SCAN_WINDOW_HOURS = 3;
const STATE_PATH = path.join('automation', 'feedback-state.json');
const QUEUE_DIR = path.join('automation', 'feedback-queue');
const MAX_PROCESSED_HISTORY = 1000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { processed: [], lastScan: null };
  }
}

function saveState(state) {
  state.processed = state.processed.slice(-MAX_PROCESSED_HISTORY);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchRecentEvents() {
  const query = `from: project_logs('${PROJECT_ID}') | filter: created >= now() - interval ${SCAN_WINDOW_HOURS} hour | select: created, input, output, metadata | sort: created desc | limit: 200`;
  const res = await fetch('https://api.braintrust.dev/btql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`btql error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data ?? [];
}

function latestPerConversation(events) {
  const byConversation = new Map();
  for (const event of events) {
    const convId = event.metadata?.conversation_id;
    if (!convId) continue;
    if (!byConversation.has(convId)) byConversation.set(convId, event); // events are sorted created desc
  }
  return byConversation;
}

async function classifyFeedback(transcript) {
  const systemPrompt = `you review a slack conversation between a user and a bot called claudesington. decide whether the user gave the bot any corrective feedback about the BOT'S OWN BEHAVIOR (formatting rules, tone, phrasing habits, emoji use, repeating itself, wrong/unhelpful answers it should do differently next time) - not just a normal task request or question.

respond with ONLY a JSON object, no other text: {"feedback": ["short imperative instruction", ...]}. each entry should be a concrete, specific instruction a developer could implement (e.g. "always put a space after commas in replies", "stop using the rocket emoji"). if there is no such feedback, respond {"feedback": []}.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`groq error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const content = data.choices?.[0]?.message?.content ?? '{"feedback": []}';
  const match = content.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : content);
    return Array.isArray(parsed.feedback) ? parsed.feedback : [];
  } catch {
    return [];
  }
}

function safeFileName(conversationId) {
  return conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
}

async function main() {
  const state = loadState();
  const processed = new Set(state.processed);

  const events = await fetchRecentEvents();
  const latest = latestPerConversation(events);

  const now = Date.now();
  let queued = 0;

  for (const [convId, event] of latest) {
    if (processed.has(convId)) continue;

    const idleMinutes = (now - new Date(event.created).getTime()) / 60000;
    if (idleMinutes < IDLE_MINUTES) continue; // still an active conversation

    const priorThread = event.input?.thread_context || '';
    const lastUserMessage = event.input?.message || '';
    const lastBotReply = event.output?.response || '';
    const transcript = `${priorThread}\n[Kensington Belza]: ${lastUserMessage}\n[claudesington (you)]: ${lastBotReply}`.trim();

    let feedback = [];
    try {
      feedback = await classifyFeedback(transcript);
    } catch (e) {
      console.error(`classify failed for ${convId}: ${e.message}`);
      continue; // leave unprocessed, retry next scan
    }

    if (feedback.length > 0) {
      fs.mkdirSync(QUEUE_DIR, { recursive: true });
      const filePath = path.join(QUEUE_DIR, safeFileName(convId));
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            conversationId: convId,
            channel: event.metadata?.channel,
            detectedAt: new Date(now).toISOString(),
            lastMessageAt: event.created,
            transcript,
            feedback,
          },
          null,
          2,
        ) + '\n',
      );
      queued += 1;
      console.log(`queued feedback for ${convId}: ${feedback.join(' | ')}`);
    }

    processed.add(convId);
  }

  state.processed = Array.from(processed);
  state.lastScan = new Date(now).toISOString();
  saveState(state);

  console.log(`scan complete: ${latest.size} conversations seen, ${queued} queued for fixing`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
