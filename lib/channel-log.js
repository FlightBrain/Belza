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

// ---- bulk / backfill path ----

// Dedupe-aware bulk insert, for scripts/backfill-history.js.
//
// appendChannelLog above appends blindly, which is correct for the live path
// (Slack delivers each event once and lib/dedup.js already guards retries)
// but wrong for a backfill: re-running it, or resuming an interrupted run,
// would re-append every message it already wrote. Slack's message `ts` is
// unique per channel, so it is the natural dedupe key.
//
// Returns { inserted, skipped, total } so the caller can report real stats
// instead of guessing.
export async function appendChannelLogBulk(channelId, entries) {
  if (!channelId || !entries?.length) return { inserted: 0, skipped: 0, total: 0 };

  try {
    const existing = await getChannelLog(channelId);
    const { log, inserted, skipped } = mergeLogEntries(existing, entries);

    if (inserted > 0) {
      if (kvAvailable) {
        await kv.set(`${LOG_PREFIX}${channelId}`, log);
      }
      memoryFallback.set(channelId, log);
    }
    return { inserted, skipped, total: log.length };
  } catch (e) {
    console.error(`channel-log: bulk append failed for ${channelId}:`, e.message);
    return { inserted: 0, skipped: 0, total: 0, error: e.message };
  }
}

// Pure merge used by appendChannelLogBulk, split out so the dedupe rule can
// be unit-tested without KV.
//
// Ordering: chronological by `ts`. Entries with no ts sort to the END rather
// than the front, because the only entries that lack one come from the live
// path (which is by definition more recent than anything a backfill inserts),
// and the cap below drops from the front.
export function mergeLogEntries(existing, incoming, maxEntries = MAX_LOG_ENTRIES) {
  const log = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set();
  for (const entry of log) {
    if (entry?.ts) seen.add(String(entry.ts));
  }

  let inserted = 0;
  let skipped = 0;

  for (const entry of incoming || []) {
    if (!entry?.message) {
      skipped += 1;
      continue;
    }
    const ts = entry.ts ? String(entry.ts) : null;
    // A tsless backfill entry is unmergeable - we cannot tell it apart from
    // one we already wrote - so it is dropped rather than duplicated.
    if (!ts) {
      skipped += 1;
      continue;
    }
    if (seen.has(ts)) {
      skipped += 1;
      continue;
    }
    seen.add(ts);
    log.push({
      userId: entry.userId || null,
      displayName: entry.displayName || null,
      message: entry.message,
      ts,
      threadTs: entry.threadTs || null,
      timestamp: entry.timestamp || tsToIso(ts),
      source: entry.source || 'backfill',
    });
    inserted += 1;
  }

  log.sort((a, b) => sortKey(a) - sortKey(b));
  while (log.length > maxEntries) log.shift();

  return { log, inserted, skipped };
}

function sortKey(entry) {
  const n = entry?.ts ? parseFloat(entry.ts) : NaN;
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

// Slack ts is epoch seconds with a microsecond suffix ("1723489200.000100").
// The live path stamps `timestamp` with "now", which would date every
// backfilled message to the day the backfill ran and make the distilled
// "[Mon DD]" prefixes wrong.
export function tsToIso(ts) {
  const seconds = parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

// ---- test helpers ----
export function _resetChannelLog() {
  memoryFallback.clear();
}
