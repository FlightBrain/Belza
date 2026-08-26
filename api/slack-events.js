import { waitUntil } from '@vercel/functions';
import getRawBody from 'raw-body';
import { verifySlackSignature, postToSlack, resolveUser, fetchThreadMessages } from '../lib/slack.js';
import { detectTrigger, isBotInThread } from '../lib/trigger.js';
import { isDuplicate } from '../lib/dedup.js';
import { cleanSlackText } from '../lib/parse.js';
import { classifyIntent, hasWorkSignal } from '../lib/intent.js';
import { getCapabilities, capabilitySummary } from '../lib/capabilities.js';
import { fetchContext } from '../lib/context.js';
import { fetchCalendarContext } from '../lib/calendar.js';
import { buildThreadContext } from '../lib/thread-context.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { callClaude } from '../lib/claude.js';
import { applyGuardrails } from '../lib/guardrails.js';
import { executeRelay } from '../lib/relay.js';
import { updateJob } from '../lib/relay-store.js';
import { handleReaction } from '../lib/feedback.js';
import { logTrace, traceId, logFeedback } from '../lib/braintrust.js';
import { getUserProfile, getUserHistory, updateUserProfile, profileToPromptContext } from '../lib/user-profiles.js';
import { createReminder, parseReminderTime, getUserReminders } from '../lib/reminders.js';

// v2 - force cold start after deploy
export const config = {
  api: { bodyParser: false },
};

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

  // Only respond to direct mentions, inferred questions, or thread continuation
  let trigger = detectTrigger(event.text);

  // Thread continuation: if the bot is already in a thread and someone replies
  // without @mentioning, treat it as an implicit trigger.
  if (!trigger && event.thread_ts) {
    const threadMsgs = await fetchThreadMessages(event.channel, event.thread_ts);
    if (isBotInThread(threadMsgs, botUserId)) {
      trigger = 'thread_continuation';
      console.log('trigger: thread_continuation (bot already in thread)');
    }
  }

  if (!trigger) return;

  // Clean Slack markup before further processing
  const cleanedText = cleanSlackText(event.text);
  if (!cleanedText) return;

  // Classify intent for behavioral constraints
  const intent = classifyIntent(cleanedText);

  console.log(
    `event: trigger=${trigger} intent=${intent} channel=${event.channel}`,
  );

  // Thread routing for the final reply
  const replyThreadTs =
    event.thread_ts || (trigger === 'direct' ? event.ts : undefined);

  // --- RELAY PATH ---
  // Only relay when the intent genuinely needs grounded Notion/Calendar data.
  // If relay returns a non-answer, it returns null and we fall through to local.
  const threadContext = await buildThreadContext(event);
  const workSignal = hasWorkSignal(cleanedText);

  let relayResult = null;
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
            intent,
            path: 'relay',
          },
          tags: ['slack-bot'],
          startTime: processStart,
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

  const [notionContext, calendarContext] = await Promise.all([
    fetchContext(),
    fetchCalendarContext(),
  ]);

  const systemPrompt = buildSystemPrompt({
    notionContext,
    calendarContext,
    capabilities,
    intent,
    threadContext,
    senderName,
    userContext,
  });

  const result = await callClaude(systemPrompt, cleanedText, { senderName, intent });
  if (!result?.reply || result.reply === '[SKIP]') return;

  const posted = await postToSlack({
    channel: event.channel,
    text: result.reply,
    thread_ts: replyThreadTs,
  });

  // Log to Braintrust with full context.
  if (posted.ts) {
    try {
      const btResult = await logTrace({
        id: traceId(event.channel, posted.ts),
        input: {
          message: cleanedText,
          notion_context: notionContext || null,
          thread_context: threadContext || null,
        },
        output: {
          response: result.reply,
          model: result.model,
          tokens: result.tokens,
          latency_ms: result.latencyMs,
        },
        metadata: {
          channel: event.channel,
          slack_user: event.user || null,
          sender_name: senderName || null,
          thread_ts: replyThreadTs || null,
          intent,
          path: 'local',
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
