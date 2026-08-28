// Event dedup, KV-backed with an in-memory fast path.
//
// WHY THIS CHANGED
// Slack delivers a single @mention as BOTH an `app_mention` event and a
// `message` event. The old handler resolved that by unconditionally SKIPPING
// every `message` event whose text contained the bot's mention, betting that
// `app_mention` would always arrive.
//
// That bet failed silently. Observed in production: plain channel messages
// were still being processed (ambient logging kept working), while every
// single @mention produced no reply, no filler, and no relay request for ~22
// hours. If `app_mention` stops being delivered - a changed event
// subscription, an app reinstall, a scope change - the bot goes mute to anyone
// addressing it directly, and nothing in the logs says so, because the skip
// path looks like normal operation.
//
// So: stop betting. Both event types carry the SAME channel + ts + user for a
// given human message, so the same dedup key already covers them. Process
// whichever arrives first and drop the other.
//
// The in-memory Map only dedupes within one warm instance, which is why this is
// now KV-backed: two Vercel instances handling app_mention and message
// concurrently would each see an empty local Map and both reply. `set` with
// `nx: true` is atomic, so exactly one wins.

import { kv } from '@vercel/kv';

const SEEN_TTL_MS = 120_000; // 2 minutes
const SEEN_TTL_S = 120;
const DEDUP_PREFIX = 'seen:';

const kvAvailable = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const seen = new Map();

// The key deliberately excludes event.type: app_mention and message for the
// same human message must collide.
function keyFor(event) {
  return `${event.channel}:${event.ts}:${event.user || ''}`;
}

// Synchronous, warm-instance-only check. Kept as a fast path and as the
// fallback when KV is unavailable.
export function isDuplicate(event) {
  const key = keyFor(event);
  if (seen.has(key)) return true;
  seen.set(key, Date.now());

  if (seen.size > 500) {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, v] of seen) {
      if (v < cutoff) seen.delete(k);
    }
  }
  return false;
}

// Cross-instance claim. Returns true if THIS invocation should process the
// event, false if someone else already claimed it.
//
// Falls back to the in-memory check when KV is unavailable or errors - which
// can double-reply across cold instances, but a rare duplicate is a far better
// failure than the silent total mute this replaces.
export async function claimEvent(event) {
  if (isDuplicate(event)) return false;
  if (!kvAvailable) return true;

  try {
    // nx: atomic set-if-not-exists. Exactly one invocation gets the claim.
    const won = await kv.set(`${DEDUP_PREFIX}${keyFor(event)}`, Date.now(), {
      nx: true,
      ex: SEEN_TTL_S,
    });
    // @vercel/kv returns 'OK' on success and null when the key already existed.
    return won !== null;
  } catch (e) {
    console.error('dedup: kv claim failed, falling back to in-memory:', e.message);
    return true;
  }
}

// Exported for testing.
export function _resetDedup() {
  seen.clear();
}
