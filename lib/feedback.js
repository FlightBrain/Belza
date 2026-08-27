// Handle reaction events (thumbs up/down) and attach scores to
// existing Braintrust traces. The trace was already logged at request
// time with full input/output/context, so we just add the score.

import { traceId, logFeedback } from './braintrust.js';
import { fetchMessage } from './slack.js';

const POSITIVE = new Set(['+1', 'thumbsup', 'white_check_mark', 'heavy_check_mark', 'heart']);
const NEGATIVE = new Set(['-1', 'thumbsdown', 'x', 'no_entry_sign']);

export async function handleReaction(event) {
  try {
    const { reaction, item, user } = event;
    if (item?.type !== 'message') return;

    const isPositive = POSITIVE.has(reaction);
    const isNegative = NEGATIVE.has(reaction);
    if (!isPositive && !isNegative) return;

    // Only reactions on the bot's own messages correspond to a logged trace.
    // Without this check, a reaction on anyone else's message still passes
    // traceId() and logFeedback() happily writes a new input-less, orphaned
    // trace (scores with no input/output to correlate them against).
    const botUserId = process.env.SLACK_BOT_USER_ID || '';
    const targetMessage = await fetchMessage(item.channel, item.ts);
    const isBotMessage =
      targetMessage && (targetMessage.bot_id || targetMessage.user === botUserId);
    if (!isBotMessage) {
      console.log(`reaction feedback skipped: ${item.channel}:${item.ts} is not a bot message`);
      return;
    }

    // The trace ID is deterministic from channel + bot reply ts.
    // This matches the ID used when we logged the trace at request time.
    const id = traceId(item.channel, item.ts);

    const result = await logFeedback({
      id,
      scores: { thumbs: isPositive ? 1 : 0 },
      metadata: {
        slack_user: user,
        reaction,
        channel: item.channel,
        messageTs: item.ts,
      },
    });

    console.log(
      `bt feedback: ${isPositive ? '+' : '-'} :${reaction}: -> ${id}`,
      result?.row_ids ? 'ok' : 'failed',
    );
  } catch (e) {
    console.error(`bt feedback error: ${e.message}`);
  }
}
