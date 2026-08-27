// Channel-wide ambient message log. Unlike the per-user history in
// user-profiles.js (which only captures what one person said), this keeps a
// single chronological feed across everyone in the channel, so the
// memory-distill job can catch facts said ABOUT other people ("alice's last
// day is friday") that wouldn't show up in any one person's own history.

import { kv } from '@vercel/kv';

const LOG_PREFIX = 'chanlog:';
const MAX_LOG_ENTRIES = 5000;

const kvAvailable = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const memoryFallback = new Map();

export async function appendChannelLog(channelId, { userId, displayName, message, ts }) {
  if (!channelId || !message) return;
  const entry = {
    userId: userId || null,
    displayName: displayName || null,
    message,
    ts: ts || null,
    timestamp: new Date().toISOString(),
  };

  try {
    const log = await getChannelLog(channelId);
    log.push(entry);
    while (log.length > MAX_LOG_ENTRIES) log.shift();

    if (kvAvailable) {
      await kv.set(`${LOG_PREFIX}${channelId}`, log);
    }
    memoryFallback.set(channelId, log);
  } catch (e) {
    console.error(`channel-log: append failed for ${channelId}:`, e.message);
  }
}

export async function getChannelLog(channelId) {
  if (!channelId) return [];
  try {
    if (kvAvailable) {
      return (await kv.get(`${LOG_PREFIX}${channelId}`)) || [];
    }
    return memoryFallback.get(channelId) || [];
  } catch (e) {
    console.error(`channel-log: get failed for ${channelId}:`, e.message);
    return memoryFallback.get(channelId) || [];
  }
}

// Entries strictly newer than sinceTs (Slack message ts, e.g. "1723489200.000100").
// Pass null/undefined to get the whole log.
export async function getChannelLogSince(channelId, sinceTs) {
  const log = await getChannelLog(channelId);
  if (!sinceTs) return log;
  return log.filter((entry) => entry.ts && parseFloat(entry.ts) > parseFloat(sinceTs));
}

// ---- test helpers ----
export function _resetChannelLog() {
  memoryFallback.clear();
}
