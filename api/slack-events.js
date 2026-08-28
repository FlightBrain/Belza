import { waitUntil } from '@vercel/functions';
import getRawBody from 'raw-body';
import { verifySlackSignature, postToSlack, resolveUser, fetchThreadMessages } from '../lib/slack.js';
import { detectTrigger, isBotInThread, isAddressedToOtherUser } from '../lib/trigger.js';
import { isDuplicate } from '../lib/dedup.js';
import { cleanSlackText } from '../lib/parse.js';
import { classifyIntent, hasWorkSignal, wantsMarketingEvents } from '../lib/intent.js';
import { getCapabilities, capabilitySummary } from '../lib/capabilities.js';
import { buildThreadContext } from '../lib/thread-context.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { fitSections, budgetLogLine, RECOMMENDED_PROMPT_BUDGET_TOKENS } from '../lib/token-budget.js';
import { callClaude } from '../lib/claude.js';
import { applyGuardrails } from '../lib/guardrails.js';
import { redactForChannel, isPublicSurface } from '../lib/source-visibility.js';
import { executeRelay, willAttemptRelay } from '../lib/relay.js';
import { updateJob } from '../lib/relay-store.js';
import { handleReaction } from '../lib/feedback.js';
import { logTrace, traceId, logFeedback } from '../lib/braintrust.js';
import {
  getUserProfile,
  getUserHistory,
  updateUserProfile,
  profileToPromptContext,
  teammateFactsToPromptContext,
} from '../lib/user-profiles.js';
import {
  getIdentityRoster,
  invalidateRoster,
  refreshRoster,
  humans,
  findById,
} from '../lib/roster.js';
import {
  resolvePeople,
  identityToPromptContext,
  ambiguityPrompt,
  substituteMentions,
} from '../lib/identity.js';
import { createReminder, parseReminderTime } from '../lib/reminders.js';
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

// Wrapper so background work (roster refresh) is always awaited before the
// invocation is allowed to end, on every return path. processEvent itself
// runs inside Vercel's waitUntil, which only keeps the function alive until
// the promise IT was handed resolves - so an un-awaited refresh could be
// killed mid-write.
async function processEvent(body) {
  const background = [];
  try {
    await processEventInner(body, background);
  } catch (e) {
    // waitUntil() just forwards the promise; it does not catch. Without this,
    // any throw in the pipeline became an unhandled rejection and the user got
    // silence - no reply, no error, nothing in the logs beyond the crash.
    console.error('processEvent failed:', e.message, e.stack?.slice(0, 400));
  } finally {
    if (background.length) await Promise.allSettled(background);
  }
}

async function processEventInner(body, background) {
  const processStart = new Date().toISOString();
  const event = body?.event;
  if (!event) return;

  // Handle reaction events for feedback tracking
  if (event.type === 'reaction_added') {
    console.log(`reaction: :${event.reaction}: on ${event.item?.channel}:${event.item?.ts}`);
    await handleReaction(event);
    return;
  }

  // Identity-changing events invalidate the cached roster so the next lookup
  // rebuilds it. These only arrive if the corresponding event subscriptions
  // are enabled in the Slack app config; harmless no-op if they never fire.
  if (event.type === 'user_change' || event.type === 'team_join') {
    await invalidateRoster(AMBIENT_LOG_CHANNEL_ID);
    return;
  }
  if (event.type === 'member_joined_channel' || event.type === 'member_left_channel') {
    await invalidateRoster(event.channel);
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

  // Trigger detection runs on RAW text (it looks for the literal <@BOTID>)
  // and needs no roster, so it comes first. Doing the roster load before this
  // meant every human message in every channel the bot sits in paid for a
  // roster - including a blocking conversations.members + N x users.info
  // fan-out on first contact with a channel the bot will never reply in.
  //
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

  // Cheap exit before any roster or LLM work: not for the bot, and not in the
  // channel we keep ambient memory for, so there is nothing to do.
  if (!trigger && event.channel !== AMBIENT_LOG_CHANNEL_ID) {
    console.log(`no trigger: ignoring channel=${event.channel} thread_ts=${event.thread_ts || 'none'} ts=${event.ts}`);
    return;
  }

  // Roster, because mention resolution depends on it.
  //
  // Lazy + TTL-cached: a fresh roster is a single KV read, a stale one is
  // served immediately while it refreshes behind the reply, and only a cold
  // cache blocks. No scheduler involved - see the header of lib/roster.js
  // for why a cron was rejected. Always anchored on the team channel so a DM
  // or another channel can still resolve teammates; see getIdentityRoster.
  const roster = await getIdentityRoster(event.channel, AMBIENT_LOG_CHANNEL_ID, {
    keepAlive: (p) => background.push(p),
  });

  // THE ORDER THAT MATTERS: substitute <@U…> mentions to real names using
  // the roster BEFORE cleanSlackText gets a chance to degrade them to the
  // literal string "@U09GGU5ED24". Everything downstream - intent, name
  // matching, the prompt, the channel log - sees names, never raw IDs.
  const namedText = substituteMentions(event.text, roster, botUserId);
  const cleanedText = cleanSlackText(namedText);
  if (!cleanedText) return;

  if (!trigger) {
    // Not directed at the bot, but it IS in the SDR friends channel, so still
    // remember it happened - ambient memory, fed continuously instead of
    // only on bot-directed messages. Awaited (not fire-and-forget) because
    // this whole handler runs inside Vercel's waitUntil, which only keeps
    // the invocation alive until the promise IT'S GIVEN resolves - an
    // un-awaited chain here could get cut off mid-write once processEvent
    // returns, silently dropping the KV writes.
    if (event.user) {
      try {
        // Prefer the roster's name: it already applies Slack's
        // display_name -> real_name -> handle fallback (3 of 13 humans in
        // this channel have an empty display_name), it's consistent with
        // what identity resolution matches on, and it costs no API call.
        const rosterEntry = findById(roster, event.user);
        const displayName = rosterEntry?.preferredName || (await resolveUser(event.user));
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

  // Manual roster refresh. The TTL is 6h, which is right for normal use but
  // useless when you've just renamed someone and want to test it. Escape
  // hatch so nobody has to wait on a cache.
  if (/\b(refresh|rebuild|reload)\s+(the\s+)?roster\b/i.test(cleanedText)) {
    // Refresh the TEAM channel, because that is what getIdentityRoster
    // anchors on. Refreshing event.channel meant that in a DM this wrote a
    // KV key nothing ever reads, so the documented escape hatch did nothing.
    // The current channel is refreshed too when it's a real channel that the
    // merge actually consults.
    const targets = [AMBIENT_LOG_CHANNEL_ID];
    if (event.channel !== AMBIENT_LOG_CHANNEL_ID && /^[CG]/.test(event.channel)) {
      targets.push(event.channel);
    }

    let text;
    try {
      const results = await Promise.all(targets.map((c) => refreshRoster(c)));
      const merged = new Map();
      for (const r of results) for (const p of r.people) merged.set(p.userId, p);
      const all = [...merged.values()];
      const active = all.filter((p) => !p.isBot && !p.deleted);
      const anyPartial = results.some((r) => r.partial);
      text =
        `roster refreshed: ${active.length} teammates, ` +
        `${all.length - active.length} bots/deactivated.` +
        (anyPartial ? ' some lookups were rate limited, serving cached entries for those.' : '');
    } catch (e) {
      // refreshRoster throws on any non-ok Slack response. Unhandled here it
      // rejected out through waitUntil, which does not catch, so the user got
      // no reply and no error at all.
      console.error(`roster refresh command failed: ${e.message}`);
      text = "couldn't refresh the roster just now, slack pushed back. try again in a minute.";
    }

    await postToSlack({ channel: event.channel, text, thread_ts: replyThreadTs });
    return;
  }

  // ---- IDENTITY RESOLUTION ----
  // Resolved from the RAW event text so mention syntax is consumed before
  // any fuzzy matching. Tags are authoritative; typed names are matched
  // against roster aliases (real name, display name, handle, past names).
  const resolved = resolvePeople({
    rawText: event.text,
    roster,
    botUserId,
    excludeUserId: event.user,
  });

  // An ambiguous name must be asked about, never guessed - but only when the
  // message is actually ASKING about a person. Gating every intent meant an
  // incidentally-mentioned ambiguous name suppressed the real answer: with two
  // Alecs, "whats the pricing page, alec said it moved" got "which alec do you
  // mean" instead of the link. For any other intent we just carry no facts for
  // that name and answer the question that was asked.
  if (resolved.ambiguous.length > 0) {
    const aliases = resolved.ambiguous.map((a) => a.alias);
    if (intent === 'identity_person_lookup') {
      const question = ambiguityPrompt(resolved.ambiguous);
      console.log(`identity: ambiguous ${JSON.stringify(aliases)}, asking`);
      await postToSlack({ channel: event.channel, text: question, thread_ts: replyThreadTs });
      // Still record the turn. This reply path was previously invisible to
      // both the profile store and Braintrust. Full span tracing for it lands
      // in Phase 3 alongside the rest of the instrumentation.
      if (event.user) {
        await updateUserProfile(event.user, {
          displayName: await resolveUser(event.user),
          message: cleanedText,
          intent,
          channel: event.channel,
        }).catch((e) => console.error('profile update failed:', e.message));
      }
      return;
    }
    console.log(`identity: ambiguous ${JSON.stringify(aliases)} but intent=${intent}, ignoring and answering`);
  }

  // Apps in the channel (Notion, ChatGPT Agents, claudesington itself) can
  // be tagged like anyone else, but they are not teammates to look up.
  const taggedApps = resolved.people.filter((p) => p.isBot);
  const teammates = resolved.people.filter((p) => !p.isBot);

  // Grounded facts per person: Slack profile identity (title, full name,
  // deactivation, former names) plus whatever the profile store knows
  // (channel notes, life events). Identity alone is enough to answer "who
  // is X" - it comes straight from the Slack profile, so a person with zero
  // notes still gets a true answer instead of a deflection.
  const mentionedFacts = (
    await Promise.all(
      teammates.map(async (person) => {
        const profile = await getUserProfile(person.userId);
        const parts = [
          identityToPromptContext(person),
          teammateFactsToPromptContext(profile),
        ].filter(Boolean);
        return { name: person.preferredName, facts: parts.join('\n'), via: person.via };
      }),
    )
  ).filter((m) => m.facts);

  const appContext = taggedApps
    .map((p) => `*${p.preferredName}*:\nslack profile: an app/bot in this channel, not a teammate`)
    .join('\n\n');

  const mentionedContext = [
    ...mentionedFacts.map((m) => `*${m.name}*:\n${m.facts}`),
    appContext,
  ]
    .filter(Boolean)
    .join('\n\n');

  if (resolved.people.length || resolved.unknownTags.length || resolved.subteamIds.length) {
    console.log(
      `identity: resolved=[${resolved.people.map((p) => `${p.preferredName}:${p.via}`).join(', ')}]` +
        ` unknown_tags=[${resolved.unknownTags.join(', ')}]` +
        ` subteams=[${resolved.subteamIds.join(', ')}]`,
    );
  }

  // A person lookup we can answer locally: we identified a real teammate and
  // have at least one grounded fact about them. No need to burn ~55s on the
  // Notion relay for something the Slack profile already answers.
  const hasLocalPersonLookup =
    intent === 'identity_person_lookup' && mentionedFacts.length > 0;

  // --- RELAY PATH ---
  // Only relay when the intent genuinely needs grounded Notion/Calendar data.
  // If relay returns a non-answer, it returns null and we fall through to local.
  const threadContext = await buildThreadContext(event);
  // wantsMarketingEvents is folded into the relay signal. Before this,
  // "what marketing events are upcoming" classified as general_qna with no
  // work keyword, so it never relayed - it was served ONLY by the direct
  // Notion API path, which was dead. The question got no grounded data at all.
  const workSignal = hasWorkSignal(cleanedText) || wantsMarketingEvents(cleanedText);

  // The relay poll can take up to ~55s (lib/relay-config.js RELAY_TIMEOUT_MS),
  // which reads as the bot going silent/stuck in a fast-moving thread. Post a
  // quick filler first so it's clear something is happening.
  if (!hasLocalPersonLookup && willAttemptRelay({ event, cleanedText, intent, hasWorkSignal: workSignal })) {
    const filler = RELAY_FILLERS[Math.floor(Math.random() * RELAY_FILLERS.length)];
    await postToSlack({ channel: event.channel, text: filler, thread_ts: replyThreadTs });
  }

  let relayResult = null;
  let relayAttempted = false;
  const relayStartedAt = new Date();
  if (!hasLocalPersonLookup) {
    relayAttempted = true;
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

    // SOURCE-VISIBILITY GATE. The relay answer comes from a Notion agent that
    // authenticates as a person, so it can see private pages, other Slack
    // channels and 1:1 notes that the people in THIS channel cannot. Strip or
    // refuse anything that could only have come from a privileged source
    // before it is spoken. See lib/source-visibility.js for what was actually
    // observed leaking.
    const visibility = redactForChannel(relayResult.answer, { channelId: event.channel });
    if (visibility.redactions.length > 0) {
      console.warn(
        `source-visibility: redacted [${visibility.redactions.join(', ')}]` +
          `${visibility.blocked ? ' and BLOCKED the answer' : ''}` +
          ` channel=${event.channel} public=${isPublicSurface(event)}`,
      );
    }

    const safeAnswer = applyGuardrails(visibility.text);

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
            source_redactions: visibility.redactions,
            source_blocked: visibility.blocked,
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
        // The reminder cron runs ONCE A DAY (vercel.json), not every 5 minutes
        // as check-reminders.js used to claim - Vercel Hobby caps cron at once
        // per day per job. Promising a precise time we cannot hit makes the bot
        // look broken rather than limited.
        text:
          `got it ${sName}, noted for ${timeStr} PT: "${aboutText}". ` +
          `heads up, i only check reminders once a day right now so it might land late.`,
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

  // Notion is NOT fetched here any more. There is exactly one Notion path now
  // and it is the relay, which already ran above - if it had an answer we
  // returned it. Reaching this point means either the message didn't warrant a
  // Notion lookup or the relay had nothing, and in both cases the local model
  // must answer from what it has rather than from a second, disagreeing source.
  // Calendar is GONE, not disabled. A Google API key gives anonymous access to
  // PUBLIC data only - verified verbatim in Google's own docs ("API keys
  // provide anonymous access to public data"), and calendars.get "requires
  // authorization". Workspace employee calendars are not public, so an API key
  // returns 404 for every teammate. Reading colleagues' calendars needs either
  // per-user OAuth or a service account with domain-wide delegation authorized
  // by a Braintrust super admin. Until that exists there is no calendar
  // source, and a source that silently returns "[not connected]" forever is
  // worse than none - it makes the prompt claim a capability that cannot work.
  const retrievalStartedAt = new Date();
  const calendarResult = null;
  const retrievalFinishedAt = new Date();

  // TOKEN BUDGET. The variable-length sections all grow without bound as
  // history accumulates: threadContext is up to 20 messages, userContext
  // carries the last 8 messages plus every channel note, and mentionedContext
  // grows with each person named. Nothing capped the total, so the prompt got
  // steadily larger until it either cost more per reply or hit a limit.
  //
  // fitSections drops and truncates by explicit priority (see
  // lib/token-budget.js SECTION_PRIORITY): identity facts about the people
  // being discussed are surrendered last, raw history first. thread_context
  // and user_history keep their END, since recent messages matter more.
  const fitted = fitSections(
    [
      { name: 'mentioned_facts', text: mentionedContext || '' },
      { name: 'calendar_context', text: calendarResult?.text || '' },
      { name: 'thread_context', text: threadContext || '' },
      { name: 'user_profile', text: userContext || '' },
    ],
    { budget: RECOMMENDED_PROMPT_BUDGET_TOKENS },
  );
  if (fitted.truncated?.length || fitted.dropped?.length) {
    console.log(budgetLogLine(fitted));
  }
  const section = (name) => fitted.sections.find((x) => x.name === name)?.text || undefined;

  const systemPrompt = buildSystemPrompt({
    calendarContext: section('calendar_context'),
    capabilities,
    intent,
    threadContext: section('thread_context'),
    senderName,
    userContext: section('user_profile'),
    mentionedContext: section('mentioned_facts'),
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
  const retrievalRecords = [...(calendarResult?.retrieval || [])];
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
          calendar_context: calendarResult?.text || null,
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
          relay_attempted: Boolean(relayAttempted),
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
