const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || '';

// Direct trigger: someone is clearly talking to the bot
const DIRECT_PATTERNS = [
  () => new RegExp(`<@${BOT_USER_ID}>`, 'i'),
  /\bclaudesington\b/i,
  /\bclaudsington\b/i,
  /\bkenbot\b/i,
  /\bhey\s+(bot|ken)\b/i,
];

// Inferred: question about Ken's accounts, schedule, or pipeline
const INFERRED_PATTERNS = [
  /\bken(sington)?\s+(has|have|covered|owns?|working|handling|doing)\b/i,
  /\bken(sington)?'?s?\s+(accounts?|pipeline|schedule|territory|deals?|meetings?|opp)\b/i,
  /\banyone\s+know\s+(if|whether)\s+ken\b/i,
  /\bdoes\s+ken\s+(have|own|cover|work)\b/i,
  /\bwhat'?s?\s+ken\s+(working|doing|up\s+to|on)\b/i,
  /\bwhere\s+is\s+ken\b/i,
  /\b(amazon|pigment|expedia|audible|coinbase|bytedance|snap|commure|intel|liveramp|cloudera|cerebras|sutter)\b.*\?/i,
];

// Returns: 'direct', 'inferred', or null (ignore)
export function detectTrigger(text) {
  if (!text) return null;

  for (const pattern of DIRECT_PATTERNS) {
    const re = typeof pattern === 'function' ? pattern() : pattern;
    if (re.test(text)) return 'direct';
  }

  for (const pattern of INFERRED_PATTERNS) {
    if (pattern.test(text)) return 'inferred';
  }

  // No match = don't respond. No chime-ins, no wasted tokens.
  return null;
}

// Check if the bot has already replied in a thread.
// Used for thread continuation: if bot is in the thread, treat follow-up
// messages as implicit triggers even without @mention.
export function isBotInThread(messages, botUserId) {
  if (!messages || !botUserId) return false;
  return messages.some(
    (m) => m.user === botUserId || (m.bot_id && m.user === botUserId),
  );
}
