// One real relay round trip, instrumented. Posts a genuine relay request to
// the relay channel, polls exactly like production does, and prints the real
// timings plus a before/after of what the cleaner stripped.
//
// Usage: node --env-file=.env scripts/trace-relay.js "your question here"

import { randomUUID } from 'node:crypto';
import { getRelayConfig } from '../lib/relay-config.js';
import { formatRelayRequest, cleanRelayResponse, isNonAnswer } from '../lib/relay.js';
import { postToSlack, fetchThreadMessages } from '../lib/slack.js';
import { applyGuardrails } from '../lib/guardrails.js';

const question = process.argv[2] || 'what is the braintrust sf office address';
const config = { ...getRelayConfig(), enabled: true };

const requestId = randomUUID();
const event = { channel: 'C093Z82DK18', ts: String(Date.now() / 1000), user: 'U09PZ2E5WLA' };

const relayText = formatRelayRequest({ requestId, event, cleanedText: question, threadContext: '', config });

console.log('='.repeat(78));
console.log('RELAY TRACE');
console.log('='.repeat(78));
console.log(`question      : ${JSON.stringify(question)}`);
console.log(`request_id    : ${requestId}`);
console.log(`relay channel : ${config.channelId}`);
console.log(`timeout       : ${config.timeoutMs}ms   poll every ${config.pollIntervalMs}ms`);
console.log(`allowlist     : ${config.botUserIds.length ? config.botUserIds.join(',') : '(EMPTY - accepts any responder)'}`);
console.log('');
console.log('--- request posted to the relay channel ---');
console.log(relayText.split('\n').map((l) => '  ' + l).join('\n'));
console.log('');

const t0 = Date.now();
const posted = await postToSlack({ channel: config.channelId, text: relayText });
if (!posted.ok) { console.error('post failed:', posted.error); process.exit(1); }
const tPosted = Date.now();
console.log(`[+${((tPosted - t0) / 1000).toFixed(2)}s] request posted, ts=${posted.ts}`);

let match = null;
let firstReplyAt = null;
let polls = 0;

while (Date.now() - tPosted < config.timeoutMs) {
  await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  polls += 1;
  const msgs = await fetchThreadMessages(config.channelId, posted.ts);
  const replies = msgs.filter((m) => m.ts !== posted.ts);
  const el = ((Date.now() - tPosted) / 1000).toFixed(1);

  if (replies.length && !firstReplyAt) {
    firstReplyAt = Date.now();
    console.log(`[+${el}s] poll #${polls}: FIRST REPLY seen from bot_id=${replies[0].bot_id || 'n/a'} user=${replies[0].user || 'n/a'}`);
  } else {
    console.log(`[+${el}s] poll #${polls}: ${replies.length} replies`);
  }

  const byId = replies.find((m) => m.text?.includes(`REQUEST_ID=${requestId}`));
  if (byId) { match = { msg: byId, how: 'REQUEST_ID match' }; break; }
}

const tDone = Date.now();
console.log('');
if (!match) {
  console.log(`RESULT: TIMEOUT after ${((tDone - tPosted) / 1000).toFixed(1)}s, ${polls} polls. Production would fall back to the local LLM path.`);
  process.exit(0);
}

console.log('--- timings ---');
console.log(`  time to first reply : ${((firstReplyAt - tPosted) / 1000).toFixed(1)}s`);
console.log(`  time to matched     : ${((tDone - tPosted) / 1000).toFixed(1)}s`);
console.log(`  total elapsed       : ${((tDone - t0) / 1000).toFixed(1)}s`);
console.log(`  polls               : ${polls}`);
console.log(`  matched by          : ${match.how}`);
console.log(`  responder           : bot_id=${match.msg.bot_id || 'n/a'} user=${match.msg.user || 'n/a'}`);
console.log('');

const raw = match.msg.text || '';
const cleaned = cleanRelayResponse(raw, requestId);
const guarded = applyGuardrails(cleaned);

console.log('--- RAW agent reply ---');
console.log(raw.split('\n').map((l) => '  | ' + l).join('\n'));
console.log('');
console.log('--- AFTER cleanRelayResponse ---');
console.log(cleaned.split('\n').map((l) => '  | ' + l).join('\n'));
console.log('');
console.log('--- AFTER applyGuardrails (what the user actually sees) ---');
console.log(guarded.split('\n').map((l) => '  | ' + l).join('\n'));
console.log('');
console.log('--- what got stripped ---');
console.log(`  raw length      : ${raw.length}`);
console.log(`  after cleaner   : ${cleaned.length}   (removed ${raw.length - cleaned.length} chars)`);
console.log(`  after guardrails: ${guarded.length}   (removed ${cleaned.length - guarded.length} chars)`);
console.log(`  isNonAnswer     : ${isNonAnswer(cleaned)}  ${isNonAnswer(cleaned) ? '<-- would be DISCARDED, falls back to local' : '<-- delivered'}`);
const strippedBits = [];
if (/REQUEST_ID/.test(raw) && !/REQUEST_ID/.test(cleaned)) strippedBits.push('REQUEST_ID trailer');
if (/View agent in Notion/i.test(raw) && !/View agent in Notion/i.test(cleaned)) strippedBits.push('"View agent in Notion" footer');
if (/notion\.so\/agent/.test(raw) && !/notion\.so\/agent/.test(guarded)) strippedBits.push('notion.so/agent URL');
if (/—/.test(raw) && !/—/.test(guarded)) strippedBits.push('em dashes');
if (/[‘’“”]/.test(raw) && !/[‘’“”]/.test(guarded)) strippedBits.push('smart quotes');
console.log(`  stripped        : ${strippedBits.length ? strippedBits.join(', ') : '(nothing notable)'}`);
console.log('');
console.log('--- source-visibility audit of this reply ---');
const notionPages = [...raw.matchAll(/app\.notion\.com\/p\/([0-9a-f]{32})/g)].map((m) => m[1]);
const slackArchives = [...raw.matchAll(/slack\.com\/archives\/([A-Z0-9]+)/g)].map((m) => m[1]);
const emails = [...raw.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0]);
console.log(`  notion page links : ${notionPages.length ? notionPages.join(', ') : 'none'}`);
console.log(`  slack archive links: ${slackArchives.length ? slackArchives.join(', ') : 'none'}`);
console.log(`  email addresses   : ${emails.length ? emails.join(', ') : 'none'}`);
