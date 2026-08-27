import { waitUntil } from '@vercel/functions';
import getRawBody from 'raw-body';
import { verifySlackSignature, postToSlack, resolveUser, fetchThreadMessages } from '../lib/slack.js';
import { detectTrigger, isBotInThread, isAddressedToOtherUser } from '../lib/trigger.js';
import { isDuplicate } from '../lib/dedup.js';
import { cleanSlackText } from '../lib/parse.js';
import { classifyIntent, hasWorkSignal, wantsMarketingEvents } from '../lib/intent.js';
import { getCapabilities, capabilitySummary } from '../lib/capabilities.js';
import { fetchContext, fetchMarketingEvents } from '../lib/context.js';
import { fetchCalendarContext } from '../lib/calendar.js';
import { buildThreadContext } from '../lib/thread-context.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { callClaude } from '../lib/claude.js';
import { applyGuardrails } from '../lib/guardrails.js';
import { executeRelay, willAttemptRelay } from '../lib/relay.js';
import { updateJob } from '../lib/relay-store.js';
import { handleReaction } from '../lib/feedback.js';
import { logTrace, traceId, logFeedback } from '../lib/braintrust.js';
import {
  getUserProfile,
  getUserHistory,
  updateUserProfile,
  profileToPromptContext,
  getKnownUsers,
  findMentionedTeammates,
  teammateFactsToPromptContext,
} from '../lib/user-profiles.js';
import { createReminder, parseReminderTime, getUserReminders } from '../lib/reminders.js';
import { appendChannelLog } from '../lib/channel-log.js';

// The SDR friends channel (sdr-playersonly). Ambient logging - remembering
// every message, not just ones directed at the bot - is scoped to just this
// channel, never the relay channel or anywhere else the bot sits.
const AMBIENT_LOG_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C093Z82DK18';

// v2 - force cold start after deploy
export const config = {
  api: { bodyParser: false },
};

// Lets Braintrust separate production traffic from local/smoke-test runs
// and pin a trace back to the exact deployed commit.
const ENVIRONMENT = process.env.VERCEL_ENV || 'development';
const APP_VERSION = process.env.VERCEL_GIT_COMMIT_SHA || 'local';

// Casual filler posted right before a (slow) relay lookup so the bot doesn't
// look frozen in a fast-moving thread.
const RELAY_FILLERS = [
  'one sec, checking notion for that.',
  'hang on, digging that up.',
  'gimme a sec to check on that.',
  'checking, one moment.',
];

async function processEvent(body) {
  const processStart = new Date().toISOString();
  const event = body?.event;
  if (!event) return;

  // Handle reaction events for feedback tracking
  if (event.type === 'reaction_added') {
    console.log(`reaction: :${event.reaction}: on ${event.item?.channel}:${event.item?.ts}`);
    await handleReaction(event);
    return;
  }

  if (!event.text) return;

  // Guard: never reply to bot messages (prevents loops)
  if (event.bot_id || event.subtype === 'bot_message') return;

  // --- DUPLICATE-EVENT FIX ---
  const botUserId = process.env.SLACK_BOT_USER_ID || '';
  if (
    event.type === 'message' &&
    botUserId &&
    new RegExp(`<@${botUserId}>`).test(event.text)
  ) {
    console.log('skip: message event deferred to app_mention handler');
    return;
  }

  // Guard: deduplicate within warm instances
  if (isDuplicate(event)) {
    console.log(`dedup: skipping duplicate event ${event.channel}:${event.ts}`);
    return;
  }

  // Clean Slack markup up front - needed for ambient logging below as well
  // as the rest of the pipeline once a trigger is confirmed.
  const cleanedText = cleanSlackText(event.text);
  if (!cleanedText) return;

  // In a DM there's no ambiguity about who a message is for - it's always
  // the bot, no @mention needed. Only real multi-person surfaces (channels,
  // group DMs) need the mention/thread-continuation logic below.
  let trigger = event.channel_type === 'im' ? 'direct' : detectTrigger(event.text);

  // Thread continuation: if the bot is already in a thread and someone replies
  // without @mentioning, treat it as an implicit trigger.
  if (!trigger && event.thread_ts) {
    const threadMsgs = await fetchThreadMessages(event.channel, event.thread_ts);
    if (isBotInThread(threadMsgs, botUserId)) {
      if (isAddressedToOtherUser(event.text, botUserId)) {
        console.log('skip: thread continuation, but message @mentions someone else');
      } else {
        trigger = 'thread_continuation';
        console.log('trigger: thread_continuation (bot already in thread)');
      }
    }
  }

  if (!trigger) {
    // Not directed at the bot, but if it's in the SDR friends channel, still
    // remember it happened - ambient memory, fed continuously instead of
    // only on bot-directed messages. Awaited (not fire-and-forget) because
    // this whole handler runs inside Vercel's waitUntil, which only keeps
    // the invocation alive until the promise IT'S GIVEN resolves - an
    // un-awaited chain here could get cut off mid-write once processEvent
    // returns, silently dropping the KV writes.
    if (event.channel === AMBIENT_LOG_CHANNEL_ID && event.user) {
      try {
        const displayName = await resolveUser(event.user);
        await Promise.all([
          updateUserProfile(event.user, {
            displayName,
            message: cleanedText,
            intent: null,
            channel: event.channel,
          }),
          appendChannelLog(event.channel, {
            userId: event.user,
            displayName,
            message: cleanedText,
            ts: event.ts,
          }),
        ]);
      } catch (e) {
        console.error('ambient log failed:', e.message);
      }
    }

    console.log(`no trigger: ignoring channel=${event.channel} thread_ts=${event.thread_ts || 'none'} ts=${event.ts}`);
    return;
  }

  // Classify intent for behavioral constraints
  const intent = classifyIntent(cleanedText);

  console.log(
    `event: trigger=${trigger} intent=${intent} channel=${event.channel}`,
  );

  // Thread routing for the final reply
  const replyThreadTs =
    event.thread_ts || (trigger === 'direct' ? event.ts : undefined);

  // Known teammates mentioned by name (e.g. "did alice leave?"). Only skip
  // the relay when we actually have grounded facts about them (channel
  // notes / life events) - being in the known-users index just means
  // they've posted a message in the channel at some point, which is true
  // of nearly everyone once ambient logging is running. Gating on index
  // membership alone would silently break "who is X" for people we have
  // nothing to say about, where the Notion relay might still have a real
  // answer.
  const knownUsers = await getKnownUsers();
  const mentionedTeammates = findMentionedTeammates(cleanedText, knownUsers, event.user);
  const mentionedFacts = (
    await Promise.all(
      mentionedTeammates.map(async (u) => {
        const profile = await getUserProfile(u.userId);
        const facts = teammateFactsToPromptContext(profile);
        return facts ? { displayName: u.displayName, facts } : null;
      }),
    )
  ).filter(Boolean);
  const mentionedContext = mentionedFacts.map((m) => `*${m.displayName}*:\n${m.facts}`).join('\n\n');
  const hasLocalPersonLookup = intent === 'identity_person_lookup' && mentionedFacts.length > 0;

  // --- RELAY PATH ---
  // Only relay when the intent genuinely needs grounded Notion/Calendar data.
  // If relay returns a non-answer, it returns null and we fall through to local.
  const threadContext = await buildThreadContext(event);
  const workSignal = hasWorkSignal(cleanedText);

  // The relay poll can take up to ~55s (lib/relay-config.js RELAY_TIMEOUT_MS),
  // which reads as the bot going silent/stuck in a fast-moving thread. Post a
  // quick filler first so it's clear something is happening.
  if (!hasLocalPersonLookup && willAttemptRelay({ event, cleanedText, intent, hasWorkSignal: workSignal })) {
    const filler = RELAY_FILLERS[Math.floor(Math.random() * RELAY_FILLERS.length)];
    await postToSlack({ channel: event.channel, text: filler, thread_ts: replyThreadTs });
  }

  let relayResult = null;
  const relayStartedAt = new Date();
  if (!hasLocalPersonLookup) {
    try {
      relayResult = await executeRelay({
        event,
        cleanedText,
        threadContext,
        intent,
        hasWorkSignal: workSignal,
      });
    } catch (e) {
      console.error(`relay error: ${e.message}`);
    }
  }
  const relayFinishedAt = new Date();

  if (relayResult) {
    if (relayResult.skipped) return;

    const safeAnswer = applyGuardrails(relayResult.answer);

    const posted = await postToSlack({
      channel: event.channel,
      text: safeAnswer,
      thread_ts: replyThreadTs,
    });

    if (relayResult.requestId) {
      updateJob(relayResult.requestId, {
        status: 'complete',
        finalPostTs: posted.ts || null,
      });
    }

    // Log to Braintrust with full context.
    if (posted.ts) {
      try {
        const btResult = await logTrace({
          id: traceId(event.channel, posted.ts),
          input: {
            message: cleanedText,
            notion_context: '[relay path - context in Notion agent]',
            thread_context: threadContext || null,
          },
          output: { response: safeAnswer },
          metadata: {
            channel: event.channel,
            slack_user: event.user || null,
            thread_ts: replyThreadTs || null,
            conversation_id: `${event.channel}:${replyThreadTs || posted.ts}`,
            intent,
            path: 'relay',
            environment: ENVIRONMENT,
            trace_kind: 'production_reply',
            app_version: APP_VERSION,
          },
          tags: ['slack-bot'],
          startTime: processStart,
          spans: [{
            name: 'relay_lookup',
            type: 'function',
            input: { question: cleanedText, request_id: relayResult.requestId || null },
            output: { answer: safeAnswer },
            metadata: { request_id: relayResult.requestId || null },
            startTime: relayStartedAt,
            endTime: relayFinishedAt,
          }],
        });
        console.log(`bt: logged trace ${traceId(event.channel, posted.ts)}`, btResult?.row_ids ? 'ok' : 'failed');
      } catch (e) {
        console.error('bt log failed:', e.message);
      }
    }

    // Update user profile on relay path too (fire-and-forget).
    if (event.user) {
      const name = await resolveUser(event.user);
      updateUserProfile(event.user, {
        displayName: name,
        message: cleanedText,
        intent,
        channel: event.channel,
      }).catch(e => console.error('profile update failed:', e.message));
    }

    console.log(
      `replied (relay): channel=${event.channel}`,
    );
    return;
  }

  // --- FEEDBACK HANDLING ---
  // Text-based feedback gets logged to Braintrust with the thread context.
  if (intent === 'feedback' && event.user) {
    const resolved = await resolveUser(event.user);
    // resolveUser returns the raw ID if the API call fails. Use "there" as fallback.
    const senderName = resolved.startsWith('U') && resolved.length > 8 ? 'there' : resolved;
    const feedbackText = cleanedText.replace(/^\s*feedback\s*[\s:\-]+/i, '').trim();

    // Find the bot's most recent reply in this thread to attach feedback to.
    let targetTraceId = null;
    if (event.thread_ts) {
      const threadMsgs = await fetchThreadMessages(event.channel, event.thread_ts);
      const botReplies = threadMsgs.filter(
        (m) => m.user === botUserId && m.ts !== event.ts,
      );
      if (botReplies.length > 0) {
        const lastBotReply = botReplies[botReplies.length - 1];
        targetTraceId = traceId(event.channel, lastBotReply.ts);
      }
    }

    // Determine sentiment from the message.
    const isPositive = /\b(good|great|helpful|nice|correct|right|perfect|thanks)\b/i.test(feedbackText);
    const isNegative = /\b(wrong|incorrect|bad|inaccurate|not helpful|unhelpful)\b/i.test(feedbackText);
    const score = isPositive ? 1 : isNegative ? 0 : 0.5;

    try {
      if (targetTraceId) {
        await logFeedback({
          id: targetTraceId,
          scores: { thumbs: score, text_feedback: 1 },
          comment: feedbackText,
          metadata: {
            slack_user: event.user,
            sender_name: senderName,
            channel: event.channel,
            feedback_type: 'text',
          },
        });
      } else {
        // No specific bot reply to attach to, log as standalone trace.
        await logTrace({
          id: traceId(event.channel, event.ts),
          input: { message: feedbackText, feedback_from: senderName },
          output: { response: '[text feedback]' },
          scores: { thumbs: score, text_feedback: 1 },
          metadata: {
            channel: event.channel,
            slack_user: event.user,
            sender_name: senderName,
            conversation_id: `${event.channel}:${event.thread_ts || event.ts}`,
            intent: 'feedback',
            feedback_type: 'text',
          },
          tags: ['slack-bot', 'feedback'],
          startTime: processStart,
        });
      }
      console.log(`bt feedback (text): ${senderName} -> ${feedbackText.slice(0, 80)}`, targetTraceId ? `attached to ${targetTraceId}` : 'standalone');
    } catch (e) {
      console.error('bt text feedback failed:', e.message, e.stack?.slice(0, 200));
    }

    // Acknowledge the feedback.
    const ack = isPositive
      ? `appreciate that ${senderName}, logged it.`
      : isNegative
        ? `noted ${senderName}, i'll get better. logged it.`
        : `got it ${senderName}, feedback logged.`;

    await postToSlack({
      channel: event.channel,
      text: ack,
      thread_ts: replyThreadTs,
    });
    return;
  }

  // --- REMINDER HANDLING ---
  if (intent === 'reminder' && event.user) {
    const resolved = await resolveUser(event.user);
    // resolveUser returns the raw ID if the API call fails. Use "there" as fallback.
    const sName = resolved.startsWith('U') && resolved.length > 8 ? 'there' : resolved;
    const triggerAt = parseReminderTime(cleanedText);

    if (triggerAt) {
      // Extract what to remind about (strip the time/trigger words).
      const aboutText = cleanedText
        .replace(/\b(remind\s+me|set\s+a?\s*reminder|schedule\s+a?\s*reminder|ping\s+me|don'?t\s+let\s+me\s+forget)\s*/i, '')
        .replace(/\b(in\s+\d+\s*\w+|at\s+\d+[:\d]*\s*(?:am|pm)?|tomorrow(?:\s+at\s+\d+[:\d]*\s*(?:am|pm)?)?|next\s+\w+|eod|end\s+of\s+day)\b/i, '')
        .replace(/\s+/g, ' ').trim()
        || cleanedText;

      const reminder = await createReminder({
        userId: event.user,
        userName: sName,
        channel: event.channel,
        threadTs: replyThreadTs,
        message: aboutText,
        triggerAt,
      });

      const timeStr = triggerAt.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });

      await postToSlack({
        channel: event.channel,
        text: `got it ${sName}, i'll ping you ${timeStr} PT: "${aboutText}"`,
        thread_ts: replyThreadTs,
      });

      // Update profile
      updateUserProfile(event.user, {
        displayName: sName, message: cleanedText, intent, channel: event.channel,
      }).catch(e => console.error('profile update failed:', e.message));

      console.log(`reminder set: ${reminder.id} for ${sName} at ${timeStr}`);
      return;
    }
    // If we couldn't parse a time, fall through to Claude to ask for clarification.
  }

  // --- LOCAL CLAUDE PATH (relay disabled or skipped for this intent) ---

  const caps = getCapabilities();
  const capabilities = capabilitySummary(caps);

  // Resolve the current speaker's name and load their profile + history.
  const senderName = event.user ? await resolveUser(event.user) : null;
  const [userProfile, userHistory] = event.user
    ? await Promise.all([getUserProfile(event.user), getUserHistory(event.user)])
    : [null, []];
  const userContext = profileToPromptContext(userProfile, userHistory);
  // mentionedContext (facts about other teammates named in this message)
  // was already computed above, alongside the relay-skip decision.

  // Only pull Notion/calendar context when the message actually calls for it —
  // stuffing every reply with SDR Hub content and calendar lookups wastes
  // calls and pollutes answers to unrelated questions.
  const wantsCalendar = intent === 'calendar_whereabouts';
  const wantsEvents = wantsMarketingEvents(cleanedText);
  const retrievalStartedAt = new Date();
  const [notionResult, calendarResult, marketingEventsResult] = await Promise.all([
    workSignal ? fetchContext() : Promise.resolve(null),
    wantsCalendar ? fetchCalendarContext() : Promise.resolve(null),
    wantsEvents ? fetchMarketingEvents() : Promise.resolve(null),
  ]);
  const retrievalFinishedAt = new Date();

  const systemPrompt = buildSystemPrompt({
    notionContext: notionResult?.text,
    calendarContext: calendarResult?.text,
    marketingEventsContext: marketingEventsResult?.text,
    capabilities,
    intent,
    threadContext,
    senderName,
    userContext,
    mentionedContext,
  });

  const llmStartedAt = new Date();
  let result;
  try {
    result = await callClaude(systemPrompt, cleanedText, { senderName, intent });
  } catch (e) {
    console.error(`claude call failed: ${e.message}`);
    result = { reply: "hit a snag on my end, try that again in a sec.", model: null, tokens: {} };
  }
  const llmFinishedAt = new Date();
  if (!result?.reply || result.reply === '[SKIP]') return;

  const posted = await postToSlack({
    channel: event.channel,
    text: result.reply,
    thread_ts: replyThreadTs,
  });

  // Retrieval spans — one per Notion page / calendar hit, carrying status,
  // latency, result count, and failure reason so a "[unavailable]" context
  // is a diagnosable retrieval span, not a silent gap in the final prompt.
  const retrievalRecords = [
    ...(notionResult?.retrieval || []),
    ...(calendarResult?.retrieval || []),
    ...(marketingEventsResult?.retrieval || []),
  ];
  const retrievalSpans = retrievalRecords.map((r) => ({
    name: r.name,
    type: 'function',
    input: { document_id: r.documentId },
    output: r.status === 'ok' ? { text: r.text, result_count: r.resultCount } : null,
    error: r.status === 'error' ? r.error : undefined,
    metadata: { status: r.status, result_count: r.resultCount },
    startTime: retrievalStartedAt,
    endTime: new Date(retrievalStartedAt.getTime() + r.latencyMs),
  }));

  const llmSpan = {
    name: 'LLM',
    type: 'llm',
    input: [{ role: 'system', content: systemPrompt }, { role: 'user', content: cleanedText }],
    output: { content: result.reply },
    metadata: { model: result.model, provider: 'groq' },
    startTime: llmStartedAt,
    endTime: llmFinishedAt,
    promptTokens: result.tokens?.input,
    completionTokens: result.tokens?.output,
    totalTokens: (result.tokens?.input || 0) + (result.tokens?.output || 0),
  };

  // Log to Braintrust with full context.
  if (posted.ts) {
    try {
      const btResult = await logTrace({
        id: traceId(event.channel, posted.ts),
        input: {
          message: cleanedText,
          notion_context: notionResult?.text || null,
          calendar_context: calendarResult?.text || null,
          marketing_events_context: marketingEventsResult?.text || null,
          thread_context: threadContext || null,
        },
        output: {
          response: result.reply,
          model: result.model,
          tokens: result.tokens,
          latency_ms: result.latencyMs,
        },
        spans: [...retrievalSpans, llmSpan],
        metadata: {
          channel: event.channel,
          slack_user: event.user || null,
          sender_name: senderName || null,
          thread_ts: replyThreadTs || null,
          conversation_id: `${event.channel}:${replyThreadTs || posted.ts}`,
          intent,
          path: 'local',
          environment: ENVIRONMENT,
          trace_kind: 'production_reply',
          app_version: APP_VERSION,
          used_notion_context: Boolean(workSignal),
          used_calendar_context: Boolean(wantsCalendar),
          used_marketing_events_context: Boolean(wantsEvents),
        },
        tags: ['slack-bot'],
        startTime: processStart,
      });
      console.log(`bt: logged trace ${traceId(event.channel, posted.ts)}`, btResult?.row_ids ? 'ok' : 'failed');
    } catch (e) {
      console.error('bt log failed:', e.message);
    }
  }

  // Update user profile after successful interaction (fire-and-forget).
  if (event.user) {
    updateUserProfile(event.user, {
      displayName: senderName,
      message: cleanedText,
      intent,
      channel: event.channel,
    }).catch(e => console.error('profile update failed:', e.message));
  }

  console.log(
    `replied (local): trigger=${trigger} intent=${intent} channel=${event.channel}`,
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (req.headers['x-slack-retry-num']) {
    console.log(`ignoring slack retry #${req.headers['x-slack-retry-num']}`);
    return res.status(200).end();
  }

  const rawBody = await getRawBody(req, { encoding: 'utf-8' });
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).end();
  }

  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).end();
  }

  waitUntil(processEvent(body));
  return res.status(200).end();
}
