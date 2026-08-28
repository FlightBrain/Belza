// Braintrust eval for the claudesington reply path.
//
// ###########################################################################
// # THIS SPENDS THE LIVE BOT'S TOKEN BUDGET. READ BEFORE RUNNING.           #
// #                                                                         #
// # The task calls lib/claude.js, which calls Groq's openai/gpt-oss-20b -   #
// # the SAME model, on the SAME key, under the SAME limits as production:   #
// #                                                                         #
// #   8000 tokens per MINUTE   (~3 replies/min for the entire workspace)    #
// #   200000 tokens per DAY    (exhausted once already today)               #
// #                                                                         #
// # So an unpaced 21-row run does not just run slowly, it takes the bot     #
// # away from the channel for the duration and can end the day's budget     #
// # for everyone (failure modes #3 and #4 in docs/FAILURE-MODES.md).        #
// #                                                                         #
// # Three guards, in order of how much they matter:                         #
// #   1. NOTHING IS SPENT WITHOUT --go. Without it this prints the plan and  #
// #      the projected wall clock and exits 0. A mistyped command cannot     #
// #      cost tokens.                                                        #
// #   2. --limit defaults to 4 rows. The full set needs --all, explicitly.   #
// #   3. Every call is paced through lib/token-pacer.js at HALF the         #
// #      per-minute limit by default, so the live bot keeps the other half.  #
// ###########################################################################
//
// WHY THE TASK RE-ASSEMBLES THE PROMPT INSTEAD OF CALLING processEvent
// The real assembly lives inline inside `processEvent` in api/slack-events.js
// and is not exported, and that file is under active edit by someone else.
// So the task calls the same modules, in the same order, with the same
// arguments - substituteMentions, cleanSlackText, classifyIntent,
// resolvePeople, identityToPromptContext, teammateFactsToPromptContext,
// profileToPromptContext, capabilitySummary, fitSections, buildSystemPrompt,
// callClaude - importing every one of them read-only. Nothing here is a
// reimplementation: if buildSystemPrompt changes, this eval changes with it.
// The one thing that cannot be mirrored is the ORDER OF THE BRANCHES around
// that assembly, so the ambiguity branch is reproduced explicitly below.
//
// Run:
//   node --env-file=.env evals/bot.eval.js                 # plan only, free
//   node --env-file=.env evals/bot.eval.js --go            # 4 rows
//   node --env-file=.env evals/bot.eval.js --all --go      # every row
//   node --env-file=.env evals/bot.eval.js --no-model      # free, no Groq
//   node evals/bot.eval.js --help

import { Eval } from 'braintrust';

import { buildPerson } from '../lib/roster.js';
import { cleanSlackText } from '../lib/parse.js';
import { classifyIntent } from '../lib/intent.js';
import {
  resolvePeople,
  substituteMentions,
  identityToPromptContext,
  ambiguityPrompt,
} from '../lib/identity.js';
import { teammateFactsToPromptContext, profileToPromptContext } from '../lib/user-profiles.js';
import { getCapabilities, capabilitySummary } from '../lib/capabilities.js';
import {
  fitSections,
  estimateTokens,
  RECOMMENDED_PROMPT_BUDGET_TOKENS,
} from '../lib/token-budget.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { callClaude } from '../lib/claude.js';
import { createTokenPacer, projectWallClockMs, formatDuration } from '../lib/token-pacer.js';

import {
  DATASET,
  PROFILE_FIXTURE,
  BOT_USER_ID,
  CASE_TYPES,
  byCaseType,
  rosterForRow,
} from './dataset.js';
import { SCORERS } from './scorers.js';

// ---------------------------------------------------------------------------
// Constants that mirror production
// ---------------------------------------------------------------------------

// Both from lib/claude.js, which exports neither. Duplicated as read-only
// constants rather than by editing that file, and named so a drift is
// obvious. If lib/claude.js changes model or caps, these two lines are the
// only thing here that needs updating.
const LIVE_MODEL = 'openai/gpt-oss-20b';
const LIVE_MAX_TOKENS = { banter: 150, bot_meta: 150, default: 400 };

// Groq's on-demand per-minute cap for this model, measured from live response
// headers (see the header of lib/token-pacer.js).
const MODEL_TPM = 8000;

// HALF, not the pacer's usual 0.85. The pacer's job in the backfill script is
// to use the budget without tripping 429s; its job here is to leave the live
// bot able to answer people while the eval runs. 0.85 would starve the
// channel for as long as the run takes.
const EVAL_SAFETY = 0.5;

const PROJECT = process.env.BRAINTRUST_EVAL_PROJECT || 'Belza';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

// Hand-rolled, like scripts/backfill-history.js, so the flags read the same
// way across the repo and an unknown flag is an error rather than a silent
// default.
function parseEvalArgs(argv) {
  const opts = {
    limit: 4,
    all: false,
    caseType: null,
    go: false,
    noModel: false,
    concurrency: 1,
    safety: EVAL_SAFETY,
    help: false,
  };
  for (const arg of argv) {
    const [flag, value] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    switch (flag) {
      case '--help': case '-h': opts.help = true; break;
      case '--all': opts.all = true; break;
      case '--go': opts.go = true; break;
      case '--no-model': opts.noModel = true; break;
      case '--limit': opts.limit = Number(value); break;
      case '--case-type': opts.caseType = value; break;
      case '--safety': opts.safety = Number(value); break;
      default:
        // Anything the braintrust CLI passes through would land here, so an
        // unrecognized flag is reported rather than treated as a row filter.
        throw new Error(`unknown flag ${flag}. try --help`);
    }
  }
  if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error('--limit must be >= 1');
  if (!(opts.safety > 0 && opts.safety <= 1)) throw new Error('--safety must be in (0, 1]');
  return opts;
}

const HELP = `
evals/bot.eval.js - scored eval of the claudesington reply path

  --go              actually call the model. WITHOUT THIS, NOTHING IS SPENT:
                    the plan and the projected wall clock are printed and the
                    process exits 0.
  --all             use every row in the dataset (default: --limit rows)
  --limit=N         how many rows to run (default 4)
  --case-type=T     only rows with this metadata.case_type
                    (${CASE_TYPES.join(', ')})
  --no-model        assemble every prompt and run every scorer against a
                    placeholder reply. Zero Groq tokens, no Braintrust key
                    needed. Use it to check the harness, not the bot.
  --safety=F        fraction of the ${MODEL_TPM}/min limit this run may use
                    (default ${EVAL_SAFETY}; the rest is left for the live bot)
  --help

The model is ${LIVE_MODEL} on Groq - the production model, the production key,
the production 8000/min and 200000/day limits. See the banner at the top of
this file.
`.trim();

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

// Roster in the shape lib/roster.js produces, built from the fixture's raw
// Slack user objects by the REAL buildPerson.
function rosterFor(dataRow) {
  const people = rosterForRow(dataRow).map((u) => buildPerson(u));
  return {
    channelId: 'C093Z82DK18',
    fetchedAt: new Date(0).toISOString(),
    memberCount: people.length,
    people,
  };
}

// Everything up to (but not including) the model call. Pure apart from
// getCapabilities reading env vars, which is what production does too.
// Returned separately from the call so the eval can price a run before making
// one, and so --no-model can exercise all of it for free.
export function assemblePrompt(dataRow) {
  const { message, sender } = dataRow.input;
  const roster = rosterFor(dataRow);

  // THE ORDER THAT MATTERS, copied from api/slack-events.js: substitute
  // mentions against the roster BEFORE cleanSlackText degrades <@U…> to the
  // literal "@U09GGU5ED24".
  const namedText = substituteMentions(message, roster, BOT_USER_ID);
  const cleanedText = cleanSlackText(namedText);
  const intent = classifyIntent(cleanedText);

  const resolved = resolvePeople({
    rawText: message,
    roster,
    botUserId: BOT_USER_ID,
    excludeUserId: sender?.userId,
  });

  // The ambiguity branch. In production this posts ambiguityPrompt and
  // RETURNS - the model is never called - and only for
  // identity_person_lookup; for any other intent an ambiguous name is
  // ignored and the real question gets answered. Reproducing that here is
  // what makes the identity_ambiguous row measure the real behavior instead
  // of measuring what the model would have said if it had been asked.
  if (resolved.ambiguous.length > 0 && intent === 'identity_person_lookup') {
    return {
      path: 'ambiguity',
      intent,
      cleanedText,
      deterministicReply: ambiguityPrompt(resolved.ambiguous),
      context: '',
      systemPrompt: null,
    };
  }

  const taggedApps = resolved.people.filter((p) => p.isBot);
  const teammates = resolved.people.filter((p) => !p.isBot);

  const mentionedFacts = teammates
    .map((person) => {
      const parts = [
        identityToPromptContext(person),
        teammateFactsToPromptContext(PROFILE_FIXTURE[person.userId]),
      ].filter(Boolean);
      return { name: person.preferredName, facts: parts.join('\n') };
    })
    .filter((m) => m.facts);

  const appContext = taggedApps
    .map((p) => `*${p.preferredName}*:\nslack profile: an app/bot in this channel, not a teammate`)
    .join('\n\n');

  const mentionedContext = [
    ...mentionedFacts.map((m) => `*${m.name}*:\n${m.facts}`),
    appContext,
  ]
    .filter(Boolean)
    .join('\n\n');

  const userContext = profileToPromptContext(PROFILE_FIXTURE[sender?.userId], []);

  // Same budget, same priorities, same function as the live path. Calendar is
  // always empty: there is no calendar source at all (README, and mode #26's
  // neighbours in the register), so a row asking about a meeting must be
  // answered with nothing, exactly as in production.
  const fitted = fitSections(
    [
      { name: 'mentioned_facts', text: mentionedContext || '' },
      { name: 'calendar_context', text: '' },
      { name: 'thread_context', text: '' },
      { name: 'user_profile', text: userContext || '' },
    ],
    { budget: RECOMMENDED_PROMPT_BUDGET_TOKENS },
  );
  const section = (name) => fitted.sections.find((x) => x.name === name)?.text || undefined;

  const systemPrompt = buildSystemPrompt({
    calendarContext: section('calendar_context'),
    capabilities: capabilitySummary(getCapabilities()),
    intent,
    threadContext: section('thread_context'),
    senderName: sender?.displayName || null,
    userContext: section('user_profile'),
    mentionedContext: section('mentioned_facts'),
  });

  return {
    path: 'local',
    intent,
    cleanedText,
    deterministicReply: null,
    // What the scorers judge fabrication against: if a claim is not in here,
    // the model did not read it anywhere.
    context: section('mentioned_facts') || '',
    systemPrompt,
    resolved: {
      people: resolved.people.map((p) => `${p.preferredName}:${p.via}`),
      unknownTags: resolved.unknownTags,
      ambiguous: resolved.ambiguous.map((a) => a.alias),
    },
  };
}

// What one row will cost, before it costs it.
export function priceRow(dataRow) {
  const assembled = assemblePrompt(dataRow);
  if (assembled.path === 'ambiguity') return { tokens: 0, assembled };
  const maxOut = LIVE_MAX_TOKENS[assembled.intent] ?? LIVE_MAX_TOKENS.default;
  // Input + the worst-case output, which is what the per-minute limit bills
  // against. The user turn is the same `[Name] says: "..."` prefix
  // lib/claude.js builds.
  const userTurn = `[${dataRow.input.sender?.displayName || ''}] says: "${assembled.cleanedText}"`;
  return {
    tokens: estimateTokens(assembled.systemPrompt) + estimateTokens(userTurn) + maxOut,
    maxOut,
    assembled,
  };
}

// ---------------------------------------------------------------------------
// Selection and projection
// ---------------------------------------------------------------------------

const opts = (() => {
  try {
    return parseEvalArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n`);
    console.error(HELP);
    process.exit(2);
  }
})();

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

let rows = DATASET;
if (opts.caseType) {
  rows = byCaseType()[opts.caseType] || [];
  if (!rows.length) {
    console.error(`no rows with case_type=${opts.caseType}. known: ${CASE_TYPES.join(', ')}`);
    process.exit(2);
  }
}
if (!opts.all) rows = rows.slice(0, opts.limit);

const priced = rows.map((r) => ({ row: r, ...priceRow(r) }));
const callable = priced.filter((p) => p.tokens > 0);
const projection = projectWallClockMs(
  callable.map((p) => ({ tokens: p.tokens })),
  { tokensPerMinute: MODEL_TPM, safety: opts.safety },
);
const totalTokens = callable.reduce((n, p) => n + p.tokens, 0);

// Groq's published on-demand price for openai/gpt-oss-20b, the same figures
// scripts/backfill-history.js uses. Input-priced across the board is a slight
// over-estimate of the input half and a large under-estimate of the output
// half, so both are counted separately.
const PRICE_IN_PER_M = 0.1;
const PRICE_OUT_PER_M = 0.5;
const outTokens = callable.reduce((n, p) => n + p.maxOut, 0);
const inTokens = totalTokens - outTokens;
const dollars = (inTokens / 1e6) * PRICE_IN_PER_M + (outTokens / 1e6) * PRICE_OUT_PER_M;

console.log('');
console.log(`claudesington eval plan`);
console.log(`  braintrust project : ${PROJECT}${process.env.BRAINTRUST_API_KEY ? '' : '   (BRAINTRUST_API_KEY NOT SET)'}`);
console.log(`  model              : ${LIVE_MODEL}  (production model, production key)`);
console.log(`  rows               : ${rows.length} of ${DATASET.length}${opts.caseType ? ` (case_type=${opts.caseType})` : ''}`);
console.log(`  model calls        : ${callable.length}  (${priced.length - callable.length} answered deterministically, no call)`);
console.log(`  scorers            : ${SCORERS.map((s) => s.name).join(', ')}`);
console.log('');
console.log(`  estimated tokens   : ${totalTokens} (${inTokens} in + ${outTokens} max out)`);
console.log(`  estimated cost     : $${dollars.toFixed(4)}`);
console.log(`  share of daily cap : ${((totalTokens / 200_000) * 100).toFixed(1)}% of 200000`);
console.log(`  pacing at          : ${Math.floor(MODEL_TPM * opts.safety)}/${MODEL_TPM} tokens per minute (safety ${opts.safety})`);
console.log(`  PROJECTED WALL CLOCK: ${formatDuration(projection.ms)}` +
  `  (${formatDuration(projection.waitMs)} of it spent waiting on the rate limit,` +
  ` longest single wait ${formatDuration(projection.longestWaitMs)})`);
console.log('');
for (const p of priced) {
  const label = p.tokens ? `${String(p.tokens).padStart(5)} tok` : '  no call';
  console.log(`  ${label}  [${p.row.metadata.case_type}] ${p.row.input.message.replace(/<@[^>]+>\s*/, '')}`);
}
console.log('');

if (!opts.go && !opts.noModel) {
  console.log('DID NOT RUN. This was a plan only - zero tokens spent, nothing logged.');
  console.log('Add --go to call the model, or --no-model to exercise the harness for free.');
  console.log('');
  process.exit(0);
}

if (opts.noModel) {
  console.log('--no-model: assembling every prompt and scoring a placeholder reply. No Groq call.');
} else {
  console.log(`RUNNING. Expect roughly ${formatDuration(projection.ms)}.`);
  console.log('The live bot shares this per-minute budget; it will be slower to answer until this finishes.');
}
console.log('');

// ---------------------------------------------------------------------------
// autoevals, if it happens to be installed
// ---------------------------------------------------------------------------

// autoevals is NOT a dependency of this repo (verified: absent from
// package.json, package-lock.json and node_modules; it is only a devDependency
// of the braintrust package itself). Adding it was explicitly out of scope, so
// this degrades instead: if someone installs it later, Factuality joins the
// scorer list; if not, the run proceeds with the custom scorers alone.
//
//   npm install autoevals        # 0.3.0 at the time of writing
//
// Factuality is an LLM judge. It does NOT touch the Groq budget - it calls
// OpenAI (or the Braintrust proxy) and needs OPENAI_API_KEY - but it is still
// a per-row model call, so it is opt-in via BOT_EVAL_FACTUALITY=1 rather than
// switched on merely by being importable.
async function optionalAutoevals() {
  if (process.env.BOT_EVAL_FACTUALITY !== '1') return [];
  try {
    const { Factuality } = await import('autoevals');
    if (typeof Factuality !== 'function') return [];
    console.log('autoevals: Factuality enabled (calls OpenAI, not Groq)');
    return [Factuality];
  } catch {
    console.log('autoevals not installed, skipping Factuality. install with: npm install autoevals');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const pacer = createTokenPacer({ tokensPerMinute: MODEL_TPM, safety: opts.safety });

// Priced rows keyed by their message, so the task can reserve the right number
// of tokens without assembling the prompt twice.
const pricedByMessage = new Map(priced.map((p) => [p.row.input.message, p]));

async function task(input, hooks) {
  const dataRow = { input, metadata: hooks?.metadata || {} };
  const { assembled, tokens, maxOut } = pricedByMessage.get(input.message) || priceRow(dataRow);

  const base = {
    intent: assembled.intent,
    path: assembled.path,
    context: assembled.context,
    cleaned_text: assembled.cleanedText,
    resolved: assembled.resolved,
  };

  // No model call needed: production answers this row deterministically.
  if (assembled.path === 'ambiguity') {
    return { ...base, reply: assembled.deterministicReply, rawReply: assembled.deterministicReply };
  }

  if (opts.noModel) {
    const placeholder = '[no model call: --no-model]';
    return { ...base, reply: placeholder, rawReply: placeholder };
  }

  // WAIT BEFORE SENDING, never react to a 429. lib/claude.js does retry 429s
  // honoring Retry-After, which is right for a live reply and wrong for a
  // batch - every refusal is a wasted round trip and Groq's suggested wait
  // covers the whole window.
  const waited = await pacer.reserve(tokens);
  if (waited > 0) console.log(`  [paced ${formatDuration(waited)}] ${input.message.slice(0, 60)}`);

  const result = await callClaude(assembled.systemPrompt, assembled.cleanedText, {
    senderName: input.sender?.displayName,
    intent: assembled.intent,
  });

  // Reconcile the chars/4 estimate with what Groq actually billed, so an
  // under-estimate is paid back instead of drifting the bucket optimistic.
  //
  // KNOWN GAP: the pacer's best correction is syncFromHeaders(), which clamps
  // to Groq's own x-ratelimit-remaining-tokens. lib/claude.js does not return
  // the response headers and must not be edited here, so this run cannot
  // self-correct against ground truth - it only settles against usage. That
  // matters most on the FIRST call, when a previous process may already have
  // spent the window. --safety=0.5 is the compensation.
  const actual = (result.tokens?.input || 0) + (result.tokens?.output || 0);
  if (actual) pacer.settle(tokens, actual);

  return {
    ...base,
    // Post-guardrails, i.e. what Slack would actually show.
    reply: result.reply,
    // PRE-guardrails, i.e. what the model actually said. Every scorer prefers
    // this and noRawUserId refuses to score without it - see the banner in
    // evals/scorers.js.
    rawReply: result.rawReply,
    model: result.model,
    tokens: result.tokens,
    latency_ms: result.latencyMs,
    reserved_tokens: tokens,
    max_output_tokens: maxOut,
  };
}

const scores = [...SCORERS, ...(await optionalAutoevals())];

// maxConcurrency 1 is not a performance oversight. The 8000/min cap is
// workspace-wide, so parallel calls do not finish sooner, they just collide
// with each other and with the live bot.
const summary = await Eval(PROJECT, {
  data: rows,
  task,
  scores,
  experimentName: `phase3-${opts.all ? 'full' : `limit${rows.length}`}-${new Date().toISOString().slice(0, 16)}`,
  maxConcurrency: 1,
  metadata: {
    model: LIVE_MODEL,
    rows: rows.length,
    dataset_rows_total: DATASET.length,
    case_type_filter: opts.caseType,
    no_model: opts.noModel,
    pacing_safety: opts.safety,
    projected_wall_clock_ms: projection.ms,
    estimated_tokens: totalTokens,
  },
},
// THIRD ARGUMENT, not a field on the evaluator. Verified against
// braintrust@3.7.1: `noSendLogs` lives on EvalOptions (the 3rd parameter of
// `Eval(name, evaluator, reporterOrOpts)`), and putting it on the evaluator
// object is silently ignored - the run then dies inside loginToState with
// "Please specify an api key", which is how this was found. With it in the
// right place the whole harness runs keyless, which is what --no-model needs.
process.env.BRAINTRUST_API_KEY ? undefined : { noSendLogs: true });

console.log('');
console.log('pacer stats:', JSON.stringify(pacer.stats()));
// Eval prints its own "Experiment summary" table, so only the bits it does not
// show are echoed here. `summary.summary` is an object, not a string - printing
// it directly gives "[object Object]".
if (summary?.summary?.experimentUrl) console.log(`experiment: ${summary.summary.experimentUrl}`);

// braintrust@3.7.1 can leave handles open after an eval resolves (a documented
// hang). Exit explicitly rather than letting a finished run look stuck.
process.exit(0);
