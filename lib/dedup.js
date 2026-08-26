// In-memory event dedup cache.
// Vercel serverless functions can share memory across warm invocations,
// so this catches the common case of Slack retries within the same warm
// instance. For cross-instance dedup (e.g. app_mention + message for the
// same user turn hitting different cold starts) we rely on the event-type
// guard in the handler.

const SEEN_TTL_MS = 120_000; // 2 minutes
const seen = new Map();

// Returns true if this event was already processed (duplicate).
export function isDuplicate(event) {
  // channel + ts is unique per Slack message. user is added for safety.
  const key = `${event.channel}:${event.ts}:${event.user || ''}`;

  if (seen.has(key)) return true;

  seen.set(key, Date.now());

  // Lazy cleanup: prune old entries to avoid unbounded growth.
  if (seen.size > 500) {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, v] of seen) {
      if (v < cutoff) seen.delete(k);
    }
  }

  return false;
}

// Exported for testing.
export function _resetDedup() {
  seen.clear();
}
