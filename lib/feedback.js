// Handle reaction events (thumbs up/down) and attach scores to
// existing Braintrust traces. The trace was already logged at request
// time with full input/output/context, so we just add the score.

import { traceId, logFeedback } from './braintrust.js';

const POSITIVE = new Set(['+1', 'thumbsup', 'white_check_mark', 'heavy_check_mark', 'heart']);
const NEGATIVE = new Set(['-1', 'thumbsdown', 'x', 'no_entry_sign']);

export async function handleReaction(event) {
  try {
    const { reaction, item, user } = event;
    if (item?.type !== 'message') return;

    const isPositive = POSITIVE.has(reaction);
    const isNegative = NEGATIVE.has(reaction);
    if (!isPositive && !isNegative) return;

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
