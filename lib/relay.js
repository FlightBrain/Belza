// Core relay logic: post a structured question to the relay channel,
// poll for the Notion agent's response, clean it, return it.

import { randomUUID } from 'node:crypto';
import { getRelayConfig } from './relay-config.js';
import {
  createJob,
  updateJob,
  hasActiveJobForEvent,
} from './relay-store.js';
import { postToSlack, fetchThreadMessages } from './slack.js';

const RELAY_TIMEOUT_MSG =
  "i couldn't get a grounded answer from the knowledge base in time. " +
  'try again in a bit, or ask in the relevant slack channel directly.';

// Intents that SHOULD be relayed for grounded Notion/Calendar answers.
// Everything else stays local with Claude.
const RELAY_INTENTS = new Set([
  'calendar_whereabouts',
  'identity_person_lookup',
  'help_request',
  'draft_request',
]);

// Patterns that indicate the relay gave a non-answer (punt/deflection).
// If matched, we fall back to local Claude instead of posting the punt.
const NON_ANSWER_PATTERNS = [
  /i'?m not confident/i,
  /i'?m not finding/i,
  /i don'?t have (enough )?(relevant |internal )?(?:information|guidance|context|data|access)/i,
  /i couldn'?t find/i,
  /i (didn'?t|don'?t) find/i,
  /nothing in (the )?(braintrust )?(notion|slack|internal|knowledge)/i,
  /no (relevant |internal )?(results|guidance|context|data|information)/i,
  /didn'?t turn up/i,
  /my search only turned up unrelated/i,
  /i (searched|looked) .{0,40}(didn'?t|don'?t|couldn'?t|nothing|no results)/i,
  /not (available|accessible) (in|from|through)/i,
  /outside (of )?(my|the) (scope|context|knowledge|sources)/i,
  /beyond (my|the) (scope|context|knowledge|sources)/i,
  /i do not have any update from the sources/i,
  /i also cannot .{0,30} because i do not have/i,
];

// ---- public entry point ----

export async function executeRelay({
  event,
  cleanedText,
  threadContext,
  intent,
  hasWorkSignal,
}) {
  const config = getRelayConfig();
  if (!config.enabled) return null;

  // Only relay intents that need grounded data.
  // For general_qna, relay only if the message has work-related keywords.
  const shouldRelay =
    RELAY_INTENTS.has(intent) ||
    (intent === 'general_qna' && hasWorkSignal);

  if (!shouldRelay) return null;

  // Never relay messages originating from the relay channel itself.
  if (event.channel === config.channelId) return null;

  const eventKey = `${event.channel}:${event.ts}:${event.user || ''}`;
  if (hasActiveJobForEvent(eventKey)) {
    console.log(`relay: duplicate skipped for ${eventKey}`);
    return { skipped: true };
  }

  const requestId = randomUUID();
  createJob(requestId, eventKey, event);

  // ---- post relay request ----

  const relayText = formatRelayRequest({
    requestId,
    event,
    cleanedText,
    threadContext,
    config,
  });

  log(config, `posting request ${requestId}`);

  const postResult = await postToSlack({
    channel: config.channelId,
    text: relayText,
  });

  if (!postResult.ok) {
    updateJob(requestId, {
      status: 'failed',
      error: `post failed: ${postResult.error}`,
    });
    console.error(`relay: post failed for ${requestId}: ${postResult.error}`);
    return null; // fall back to local Claude instead of posting error
  }

  const relayTs = postResult.ts;
  updateJob(requestId, { status: 'relayed', relayMessageTs: relayTs });
  log(config, `request ${requestId} posted as ${relayTs}, polling...`);

  // ---- poll for response ----

  const response = await pollForResponse(config, requestId, relayTs);

  if (!response) {
    updateJob(requestId, { status: 'timeout' });
    console.log(`relay: timeout for ${requestId}`);
    return null; // fall back to local Claude instead of posting timeout msg
  }

  const cleanedAnswer = cleanRelayResponse(response.text, requestId);

  // If the relay gave a non-answer, fall back to local Claude.
  if (isNonAnswer(cleanedAnswer)) {
    updateJob(requestId, { status: 'non_answer' });
    console.log(`relay: non-answer detected for ${requestId}, falling back to local`);
    return null;
  }

  updateJob(requestId, {
    status: 'answered',
    matchedResponseTs: response.ts,
  });
  log(config, `matched response for ${requestId} at ts=${response.ts}`);

  return { requestId, answer: cleanedAnswer, fromRelay: true };
}

// ---- non-answer detection ----

export function isNonAnswer(text) {
  if (!text) return true;
  if (text.length < 15) return true; // too short to be useful

  for (const pattern of NON_ANSWER_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  return false;
}

// ---- relay message formatting ----

export function formatRelayRequest({
  requestId,
  event,
  cleanedText,
  threadContext,
  config,
}) {
  const lines = [
    config?.requestPrefix || '[CLAUDESINGTON_RELAY_REQUEST]',
    `request_id: ${requestId}`,
    `original_channel: ${event.channel}`,
    `original_thread_ts: ${event.thread_ts || event.ts}`,
    `original_message_ts: ${event.ts}`,
    `original_user: ${event.user || 'unknown'}`,
    '',
    'question:',
    cleanedText,
  ];

  if (threadContext) {
    lines.push('', 'context:', threadContext.slice(0, 1500));
  }

  lines.push(
    '',
    'instructions:',
    '- Answer only from grounded Braintrust Notion / Slack-connected context',
    '- Keep the answer under 6 sentences',
    '- If uncertain, say so plainly',
    '- Use plain ASCII characters only. No smart quotes, no special unicode.',
    `- End your reply with: REQUEST_ID=${requestId}`,
  );

  return lines.join('\n');
}

// ---- polling ----

async function pollForResponse(config, requestId, relayTs) {
  const start = Date.now();
  const selfBotUserId = process.env.SLACK_BOT_USER_ID || '';
  const allowedIds = config.botUserIds; // empty = accept anyone

  while (Date.now() - start < config.timeoutMs) {
    await sleep(config.pollIntervalMs);

    const messages = await fetchThreadMessages(config.channelId, relayTs);

    for (const msg of messages) {
      // Skip the relay request itself.
      if (msg.ts === relayTs) continue;

      // Skip our own replies (prevent self-loop).
      if (selfBotUserId && msg.user === selfBotUserId) continue;

      // If an allowlist is set, only accept from those IDs.
      if (allowedIds.length > 0) {
        const id = msg.bot_id || msg.user || '';
        if (!allowedIds.includes(id)) continue;
      }

      // Prefer REQUEST_ID match (most reliable).
      if (msg.text && msg.text.includes(`REQUEST_ID=${requestId}`)) {
        return msg;
      }

      // Fallback: any substantive reply from an accepted responder.
      if (msg.text && msg.text.length > 10) {
        return msg;
      }
    }
  }

  return null;
}

// ---- response cleaning ----

export function cleanRelayResponse(text, requestId) {
  if (!text) return "i got a response but couldn't parse it. try asking again.";

  let cleaned = text;

  // Strip REQUEST_ID line/trailer.
  cleaned = cleaned.replace(
    new RegExp(`\\s*REQUEST_ID\\s*=\\s*${requestId}\\s*`, 'gi'),
    '',
  );

  // Strip relay markers the agent might echo back.
  cleaned = cleaned.replace(/\[CLAUDESINGTON_RELAY_RESPONSE\]/gi, '');
  cleaned = cleaned.replace(/\[CLAUDESINGTON_RELAY_REQUEST\]/gi, '');

  // Strip structured metadata labels from the Notion agent output.
  cleaned = cleaned.replace(/^Answer:\s*/im, '');
  cleaned = cleaned.replace(/^Confidence:\s*(high|medium|low)\s*$/gim, '');
  cleaned = cleaned.replace(/^Sources\s+used:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^Source:\s*.+$/gim, '');

  // Strip Notion agent footer ("View agent in Notion" link)
  cleaned = cleaned.replace(/\s*View\s+agent\s+in\s+Notion\s*/gi, '');

  // Fix encoding artifacts from Notion/relay path.
  cleaned = normalizeEncoding(cleaned);

  // Collapse excessive blank lines and trim.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned || "i got a response but couldn't parse it. try asking again.";
}

// ---- encoding normalization ----

function normalizeEncoding(text) {
  let out = text;

  // Smart quotes -> straight quotes
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');

  // Em/en dashes -> comma or hyphen
  out = out.replace(/\u2014/g, ',');  // em dash -> comma
  out = out.replace(/\u2013/g, '-');  // en dash -> hyphen

  // Ellipsis character -> three dots
  out = out.replace(/\u2026/g, '...');

  // Non-breaking space -> regular space
  out = out.replace(/\u00A0/g, ' ');

  // Zero-width chars (joiners, non-joiners, BOM)
  out = out.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');

  // Fancy arrows -> plain
  out = out.replace(/\u2192/g, '->');
  out = out.replace(/\u2190/g, '<-');
  out = out.replace(/\u2194/g, '<->');

  // Bullet chars -> dash (for consistency in Slack mrkdwn)
  out = out.replace(/[\u2022\u2023\u25E6\u2043]/g, '-');

  // Strip any remaining control characters (except newline/tab)
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return out;
}

// ---- helpers ----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(config, msg) {
  if (config.debugLogging) console.log(`relay: ${msg}`);
}
