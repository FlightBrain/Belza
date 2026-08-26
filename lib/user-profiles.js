// Persistent user profile store backed by Vercel KV.
// Learns about users over time: who they are, what they talk about,
// how they interact with the bot, so responses can be personalized.
// Stores full message history so the bot remembers everything.

import { kv } from '@vercel/kv';

const KEY_PREFIX = 'user:';
const HISTORY_PREFIX = 'hist:';
const MAX_TOPICS = 20;
const MAX_INTERACTIONS = 15;
const MAX_HISTORY = 50;  // full messages stored per user

// Fallback: if KV isn't configured, use in-memory (survives warm instances only).
const memoryFallback = new Map();
const kvAvailable = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// ---- public API ----

// Get a user's profile. Returns null if we've never seen them.
export async function getUserProfile(userId) {
  if (!userId) return null;
  try {
    if (kvAvailable) {
      return await kv.get(`${KEY_PREFIX}${userId}`);
    }
    return memoryFallback.get(userId) || null;
  } catch (e) {
    console.error(`user-profiles: get failed for ${userId}:`, e.message);
    return memoryFallback.get(userId) || null;
  }
}

// Get a user's full message history.
export async function getUserHistory(userId) {
  if (!userId) return [];
  try {
    if (kvAvailable) {
      return (await kv.get(`${HISTORY_PREFIX}${userId}`)) || [];
    }
    return memoryFallback.get(`hist:${userId}`) || [];
  } catch (e) {
    console.error(`user-profiles: history get failed for ${userId}:`, e.message);
    return memoryFallback.get(`hist:${userId}`) || [];
  }
}

// Update a user's profile after an interaction.
// Called after every message the bot processes.
export async function updateUserProfile(userId, {
  displayName,
  message,
  intent,
  channel,
}) {
  if (!userId) return;

  const existing = await getUserProfile(userId) || createBlankProfile(userId);

  // Update basics
  if (displayName && displayName !== userId) {
    existing.displayName = displayName;
  }
  existing.lastSeen = new Date().toISOString();
  existing.messageCount = (existing.messageCount || 0) + 1;

  // Track which channels they're active in
  if (channel && !existing.channels.includes(channel)) {
    existing.channels.push(channel);
    if (existing.channels.length > 10) existing.channels.shift();
  }

  // Track intent distribution (what they usually ask about)
  existing.intentCounts[intent] = (existing.intentCounts[intent] || 0) + 1;

  // Extract and store topics from their messages
  const topics = extractTopics(message);
  for (const topic of topics) {
    existing.recentTopics = existing.recentTopics.filter(t => t !== topic);
    existing.recentTopics.push(topic);
  }
  if (existing.recentTopics.length > MAX_TOPICS) {
    existing.recentTopics = existing.recentTopics.slice(-MAX_TOPICS);
  }

  // Store a brief interaction summary
  const summary = buildInteractionSummary(message, intent);
  if (summary) {
    existing.recentInteractions.push({
      summary,
      intent,
      timestamp: new Date().toISOString(),
    });
    if (existing.recentInteractions.length > MAX_INTERACTIONS) {
      existing.recentInteractions.shift();
    }
  }

  // Detect personality signals from how they talk to the bot
  updatePersonalitySignals(existing, message);

  // Save profile and full message to history
  await Promise.all([
    saveProfile(userId, existing),
    appendToHistory(userId, { message, intent, channel, timestamp: new Date().toISOString() }),
  ]);
}

// Build a concise text block for the system prompt.
export function profileToPromptContext(profile, history) {
  if (!profile) return '';

  const lines = [];

  if (profile.displayName) {
    lines.push(`name: ${profile.displayName}`);
  }

  if (profile.messageCount > 1) {
    lines.push(`interactions: ${profile.messageCount} messages total`);
  }

  if (profile.personality.length > 0) {
    lines.push(`vibe: ${profile.personality.join(', ')}`);
  }

  const topIntent = getTopIntent(profile.intentCounts);
  if (topIntent) {
    lines.push(`usually asks about: ${topIntent}`);
  }

  if (profile.recentTopics.length > 0) {
    lines.push(`recent topics: ${profile.recentTopics.slice(-5).join(', ')}`);
  }

  // Include recent message history so the bot remembers what they've said.
  if (history && history.length > 0) {
    const recent = history.slice(-8); // last 8 messages in prompt
    lines.push('');
    lines.push('their recent messages to you:');
    for (const h of recent) {
      const date = h.timestamp ? new Date(h.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const msg = h.message?.length > 100 ? h.message.slice(0, 97) + '...' : h.message;
      lines.push(`- ${date}: "${msg}"`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

// ---- internals ----

function createBlankProfile(userId) {
  return {
    userId,
    displayName: null,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    messageCount: 0,
    channels: [],
    intentCounts: {},
    recentTopics: [],
    recentInteractions: [],
    personality: [],
  };
}

async function saveProfile(userId, profile) {
  try {
    if (kvAvailable) {
      await kv.set(`${KEY_PREFIX}${userId}`, profile, { ex: 90 * 24 * 3600 });
    }
    memoryFallback.set(userId, profile);
  } catch (e) {
    console.error(`user-profiles: save failed for ${userId}:`, e.message);
    memoryFallback.set(userId, profile);
  }
}

async function appendToHistory(userId, entry) {
  if (!entry.message) return;
  try {
    const history = await getUserHistory(userId);
    history.push(entry);
    // Cap at MAX_HISTORY, drop oldest
    while (history.length > MAX_HISTORY) history.shift();

    if (kvAvailable) {
      await kv.set(`${HISTORY_PREFIX}${userId}`, history, { ex: 90 * 24 * 3600 });
    }
    memoryFallback.set(`hist:${userId}`, history);
  } catch (e) {
    console.error(`user-profiles: history save failed for ${userId}:`, e.message);
  }
}

// Extract meaningful topics from a message.
const TOPIC_PATTERNS = [
  { re: /\b(zapier|notion|dropbox|retool|coursera|graphite|replit|navan|braintrust|langsmith|langfuse|arize)\b/gi, type: 'product' },
  { re: /\b(eval|evals|evaluation|observability|pipeline|sequence|cadence|outreach|demo|meeting|quota|territory|accounts?)\b/gi, type: 'work' },
  { re: /\b(rag|llm|gpt|agent|agents|prompt|model|fine.?tun|embeddings?|vector|search|voice)\b/gi, type: 'tech' },
  { re: /\b(builders?\s*night|trace|summit|conference|event|dinner|warriors)\b/gi, type: 'event' },
];

function extractTopics(message) {
  if (!message) return [];
  const topics = new Set();
  for (const { re } of TOPIC_PATTERNS) {
    const matches = message.matchAll(re);
    for (const m of matches) {
      topics.add(m[0].toLowerCase());
    }
  }
  return [...topics];
}

function buildInteractionSummary(message, intent) {
  if (!message) return null;
  const short = message.length > 80 ? message.slice(0, 77) + '...' : message;
  const intentLabel = intent === 'general_qna' ? '' : ` [${intent}]`;
  return `${short}${intentLabel}`;
}

const PERSONALITY_SIGNALS = [
  { trait: 'jokes around', re: /\b(lol|lmao|haha|joke|roast|funny|xd)\b/i },
  { trait: 'direct', re: /\b(give me|send me|now|asap|quick)\b/i },
  { trait: 'asks for links', re: /\b(link|url|doc|resource|deck|slides)\b/i },
  { trait: 'asks about people', re: /\b(who is|where is|where'?s)\b/i },
  { trait: 'tests the bot', re: /\b(can you|do you|are you|prove|test)\b/i },
  { trait: 'competitive intel', re: /\b(langsmith|langfuse|arize|competitor|vs)\b/i },
];

function updatePersonalitySignals(profile, message) {
  if (!message) return;
  for (const { trait, re } of PERSONALITY_SIGNALS) {
    if (re.test(message) && !profile.personality.includes(trait)) {
      profile.personality.push(trait);
      if (profile.personality.length > 6) profile.personality.shift();
    }
  }
}

function getTopIntent(intentCounts) {
  const entries = Object.entries(intentCounts || {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [intent, count] = entries[0];
  if (count < 2) return null;
  const label = intent.replace(/_/g, ' ');
  return label;
}

// ---- test helpers ----
export function _resetProfiles() {
  memoryFallback.clear();
}
