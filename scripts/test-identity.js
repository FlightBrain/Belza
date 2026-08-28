// Phase 1 acceptance harness. Exercises identity resolution end to end -
// roster -> mention substitution -> resolution -> prompt assembly -> Groq -
// for every current member of the channel, by tag, by first name, and by
// display name.
//
// CRITICAL: every assertion runs against result.rawReply, the model output
// BEFORE lib/guardrails.js. applyGuardrails rewrites /U[A-Z0-9]{8,12}/ to
// "someone", so a reply that leaked a raw user ID would read as a clean
// sentence by the time it reached Slack and the failure would be invisible.
//
// Usage:
//   node --env-file=.env scripts/test-identity.js            # resolution only, no LLM
//   node --env-file=.env scripts/test-identity.js --llm      # includes Groq calls
//   node --env-file=.env scripts/test-identity.js --llm --limit 3

import { getRoster, refreshRoster, humans } from '../lib/roster.js';
import { resolvePeople, identityToPromptContext, ambiguityPrompt } from '../lib/identity.js';
import { getUserProfile, teammateFactsToPromptContext } from '../lib/user-profiles.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { getCapabilities, capabilitySummary } from '../lib/capabilities.js';
import { callClaude } from '../lib/claude.js';
import { cleanSlackText } from '../lib/parse.js';
import { substituteMentions } from '../lib/identity.js';

const CHANNEL = process.env.SLACK_CHANNEL_ID || 'C093Z82DK18';
const BOT = process.env.SLACK_BOT_USER_ID || '';
const USE_LLM = process.argv.includes('--llm');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

const RAW_ID = /\b[UW][A-Z0-9]{7,12}\b/;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
  }
  return condition;
}

// Mirror of the production path in api/slack-events.js.
async function buildContextFor(rawText, roster, senderId) {
  const resolved = resolvePeople({
    rawText,
    roster,
    botUserId: BOT,
    excludeUserId: senderId,
  });

  const teammates = resolved.people.filter((p) => !p.isBot);
  const apps = resolved.people.filter((p) => p.isBot);

  const factBlocks = [];
  for (const person of teammates) {
    const profile = await getUserProfile(person.userId);
    const parts = [identityToPromptContext(person), teammateFactsToPromptContext(profile)]
      .filter(Boolean);
    if (parts.length) factBlocks.push(`*${person.preferredName}*:\n${parts.join('\n')}`);
  }
  for (const app of apps) {
    factBlocks.push(`*${app.preferredName}*:\nslack profile: an app/bot in this channel, not a teammate`);
  }

  const cleanedText = cleanSlackText(substituteMentions(rawText, roster, BOT));

  return { resolved, mentionedContext: factBlocks.join('\n\n'), cleanedText };
}

async function askBot(rawText, roster, senderId, senderName) {
  const { resolved, mentionedContext, cleanedText } = await buildContextFor(rawText, roster, senderId);

  const systemPrompt = buildSystemPrompt({
    capabilities: capabilitySummary(getCapabilities()),
    intent: 'identity_person_lookup',
    threadContext: '',
    senderName,
    userContext: '',
    mentionedContext,
  });

  const result = await callClaude(systemPrompt, cleanedText, {
    senderName,
    intent: 'identity_person_lookup',
  });

  return { resolved, cleanedText, mentionedContext, result };
}

async function main() {
  console.log(`bot user id: ${BOT || '(unset!)'}`);
  if (!BOT) {
    console.error('SLACK_BOT_USER_ID is not set. Resolution will not strip the bot mention.');
    process.exit(1);
  }

  const roster = await refreshRoster(CHANNEL);
  const people = humans(roster).slice(0, LIMIT);
  console.log(`roster: ${roster.people.length} members, ${humans(roster).length} humans`);
  console.log(`testing ${people.length} people x 3 forms${USE_LLM ? ' (with LLM)' : ' (resolution only)'}\n`);

  for (const person of people) {
    const first = person.aliases.find((a) => !a.includes(' ')) || person.preferredName;
    const forms = [
      ['tag', `<@${BOT}> who is <@${person.userId}>`],
      ['first', `<@${BOT}> who is ${first}`],
      ['display', `<@${BOT}> who is ${person.preferredName}`],
    ];

    console.log(`--- ${person.preferredName} (${person.userId}) | ${person.title || 'no title'}`);

    for (const [form, rawText] of forms) {
      const label = `${person.preferredName}/${form}`;

      if (!USE_LLM) {
        const { resolved } = await buildContextFor(rawText, roster, null);
        const ids = resolved.people.map((p) => p.userId);
        const ok = check(
          label,
          ids.length === 1 && ids[0] === person.userId,
          `resolved=[${ids.join(',')}]`,
        );
        console.log(`   ${form.padEnd(8)} ${ok ? 'PASS' : 'FAIL'}  resolved -> ${resolved.people.map((p) => `${p.preferredName}:${p.via}`).join(', ') || '(none)'}`);
        continue;
      }

      const { resolved, result } = await askBot(rawText, roster, null, 'Kensington Belza');
      const raw = result.rawReply || '';

      const resolvedOk = resolved.people.length === 1 && resolved.people[0].userId === person.userId;
      const noRawId = !RAW_ID.test(raw);
      // The reply should actually name the person. Accept the display name or
      // any single-token alias, case-insensitively.
      const namesThem =
        new RegExp(person.preferredName.split(/\s+/)[0], 'i').test(raw) ||
        person.aliases.some((a) => !a.includes(' ') && new RegExp(`\\b${a}\\b`, 'i').test(raw));

      check(`${label}/resolve`, resolvedOk, `resolved=[${resolved.people.map((p) => p.userId).join(',')}]`);
      check(`${label}/no-raw-id`, noRawId, `RAW REPLY LEAKED AN ID: ${raw.slice(0, 160)}`);
      check(`${label}/names-them`, namesThem, `raw reply did not name them: ${raw.slice(0, 160)}`);

      const flag = resolvedOk && noRawId && namesThem ? 'PASS' : 'FAIL';
      console.log(`   ${form.padEnd(8)} ${flag}  ${JSON.stringify(raw.replace(/\s+/g, ' ').slice(0, 150))}`);
    }
    console.log('');
  }

  console.log('='.repeat(70));
  console.log(`TOTAL: ${pass} pass / ${fail} fail  (${((pass / (pass + fail)) * 100).toFixed(1)}%)`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
