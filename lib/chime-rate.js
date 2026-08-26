// Three gates before a chime-in fires:
// 1. 10% random roll
// 2. 30-minute floor between chime-ins
// 3. Claude returns [SKIP] if nothing relevant to say

let lastChimeTimestamp = 0;
const MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function shouldChimeIn() {
  // Gate 1: probabilistic
  if (Math.random() > 0.10) return false;

  // Gate 2: rate limit
  const now = Date.now();
  if (now - lastChimeTimestamp < MIN_INTERVAL_MS) return false;

  lastChimeTimestamp = now;
  return true;
}
