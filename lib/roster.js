// Channel roster, built from the SOURCE OF TRUTH - conversations.members
// plus users.info - not from whoever happened to post a message.
//
// Why this exists: the old known-users index in lib/user-profiles.js was
// populated as a side effect of updateUserProfile, so it only ever contained
// people who had already spoken. It also stored nothing but { userId,
// displayName }, which is not enough to match a nickname, spot a bot, notice
// a deactivation, or survive a rename.
//
// REFRESH STRATEGY: lazy, on demand, with a KV-cached TTL. Deliberately NOT
// a scheduled job. Vercel Hobby caps cron at once per day per job (the same
// cap that makes check-reminders fire up to 24h late), and GitHub Actions
// schedules have proven unreliable in this repo - memory-distill has fired
// zero times and feedback-watch 3 times against a */15 cron. A lazy refresh
// has no scheduler dependency at all: it runs inside a request that is
// already happening, and the request that needs a fresh roster is exactly
// the one that triggers the refresh.

import { kv } from '@vercel/kv';
import { slackApi } from './slack.js';
import { normalizeName, buildAliases, preferredName } from './names.js';

const ROSTER_PREFIX = 'roster:';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const kvAvailable = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const memoryFallback = new Map();

// Concurrency cap on the users.info fan-out. users.info is a high-tier
// method, but a 200-person channel would still be 200 calls; keeping a lid
// on in-flight requests is what makes the 429 backoff in slackApi able to
// actually recover instead of every retry colliding.
const USER_INFO_CONCURRENCY = 6;

// ---- public API ----

// Read the cached roster. Never fetches. Returns null if nothing is cached.
export async function getCachedRoster(channelId) {
  if (!channelId) return null;
  try {
    if (kvAvailable) return (await kv.get(`${ROSTER_PREFIX}${channelId}`)) || null;
    return memoryFallback.get(channelId) || null;
  } catch (e) {
    console.error(`roster: cache read failed for ${channelId}:`, e.message);
    return memoryFallback.get(channelId) || null;
  }
}

export function isStale(roster, ttlMs = DEFAULT_TTL_MS) {
  if (!roster?.fetchedAt) return true;
  return Date.now() - new Date(roster.fetchedAt).getTime() > ttlMs;
}

// The main entry point.
//
// - Nothing cached: fetch synchronously (the caller has to wait once).
// - Cached and fresh: return it, no network.
// - Cached but stale: return the STALE roster immediately and refresh in the
//   background via the caller's keepAlive (Vercel's waitUntil). Nobody waits
//   on pagination for a roster that is almost certainly still correct.
export async function getRoster(channelId, { ttlMs = DEFAULT_TTL_MS, keepAlive, force = false } = {}) {
  if (!channelId) return emptyRoster(channelId);

  const cached = force ? null : await getCachedRoster(channelId);

  if (cached && !isStale(cached, ttlMs)) {
    return cached;
  }

  if (cached) {
    // Serve stale, refresh behind the request.
    const refresh = refreshRoster(channelId).catch((e) =>
      console.error(`roster: background refresh failed for ${channelId}:`, e.message),
    );
    if (typeof keepAlive === 'function') keepAlive(refresh);
    return { ...cached, servedStale: true };
  }

  try {
    return await refreshRoster(channelId);
  } catch (e) {
    console.error(`roster: initial fetch failed for ${channelId}:`, e.message);
    return emptyRoster(channelId);
  }
}

// Force a rebuild from the Slack API and write it to KV.
export async function refreshRoster(channelId) {
  const started = Date.now();
  const memberIds = await fetchChannelMemberIds(channelId);
  const users = await fetchUsers(memberIds);

  const previous = await getCachedRoster(channelId);
  const previousById = new Map((previous?.people || []).map((p) => [p.userId, p]));

  const people = users.map((user) => buildPerson(user, previousById.get(user.id)));

  const roster = {
    channelId,
    fetchedAt: new Date().toISOString(),
    memberCount: memberIds.length,
    people,
  };

  await saveRoster(channelId, roster);
  console.log(
    `roster: refreshed ${channelId} - ${people.length} members ` +
      `(${people.filter((p) => !p.isBot && !p.deleted).length} active humans) in ${Date.now() - started}ms`,
  );
  return roster;
}

// The roster identity resolution should match against.
//
// Always includes the team channel (sdr-playersonly), because that is the set
// of people the bot actually knows about. Without this, "who is sacha" asked
// in a DM would resolve against a two-member DM roster and fail - the bot
// would claim not to know a teammate it has notes on.
//
// If the message came from a different real channel, that channel's members
// are merged in too, so someone only present there is still resolvable. Team
// channel entries win on conflict since that is where the notes come from.
export async function getIdentityRoster(currentChannelId, teamChannelId, opts = {}) {
  const team = await getRoster(teamChannelId, opts);

  // DMs and group DMs contribute nothing useful to identity, and their
  // "members" are not teammates in any meaningful sense.
  const isRealChannel =
    currentChannelId &&
    currentChannelId !== teamChannelId &&
    /^[CG]/.test(currentChannelId);

  if (!isRealChannel) return team;

  let local;
  try {
    local = await getRoster(currentChannelId, opts);
  } catch (e) {
    console.error(`roster: identity merge skipped for ${currentChannelId}:`, e.message);
    return team;
  }

  const byId = new Map();
  for (const p of local.people || []) byId.set(p.userId, p);
  for (const p of team.people || []) byId.set(p.userId, p); // team wins

  return {
    channelId: `${teamChannelId}+${currentChannelId}`,
    fetchedAt: team.fetchedAt,
    memberCount: byId.size,
    people: [...byId.values()],
  };
}

// Drop the cache so the next getRoster refetches. Called on user_change /
// member_joined_channel / member_left_channel if those events are ever
// subscribed - harmless no-op if they never arrive.
export async function invalidateRoster(channelId) {
  if (!channelId) return;
  try {
    if (kvAvailable) await kv.del(`${ROSTER_PREFIX}${channelId}`);
    memoryFallback.delete(channelId);
    console.log(`roster: invalidated ${channelId}`);
  } catch (e) {
    console.error(`roster: invalidate failed for ${channelId}:`, e.message);
  }
}

// Real teammates: excludes bots (Notion, ChatGPT Agents, claudesington
// itself) and deactivated accounts. This is what identity resolution should
// match against - "who is @Notion" is not a teammate lookup.
export function humans(roster) {
  return (roster?.people || []).filter((p) => !p.isBot && !p.deleted);
}

export function findById(roster, userId) {
  if (!userId) return null;
  return (roster?.people || []).find((p) => p.userId === userId) || null;
}

// ---- fetching ----

async function fetchChannelMemberIds(channelId) {
  const ids = [];
  let cursor;
  let pages = 0;

  do {
    const params = { channel: channelId, limit: '200' };
    if (cursor) params.cursor = cursor;
    const data = await slackApi('conversations.members', params);
    ids.push(...(data.members || []));
    cursor = data.response_metadata?.next_cursor || '';
    pages += 1;
    if (pages > 50) {
      console.error('roster: conversations.members exceeded 50 pages, stopping');
      break;
    }
  } while (cursor);

  return ids;
}

async function fetchUsers(userIds) {
  const out = [];
  for (let i = 0; i < userIds.length; i += USER_INFO_CONCURRENCY) {
    const batch = userIds.slice(i, i + USER_INFO_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const data = await slackApi('users.info', { user: id });
          return data.user || null;
        } catch (e) {
          console.error(`roster: users.info failed for ${id}:`, e.message);
          return null;
        }
      }),
    );
    out.push(...results.filter(Boolean));
  }
  return out;
}

// ---- shaping ----

// Turn a raw Slack user object into the record we store, carrying forward
// any display/real names the person used to have. A rename is the case that
// silently breaks name matching, so previous names stay searchable.
export function buildPerson(user, previous) {
  const profile = user.profile || {};

  const displayName = profile.display_name || '';
  // profile.real_name is authoritative. Slack's own docs call the top-level
  // real_name a "top-level copy from profile", and their users.list example
  // shows the two out of sync (top-level "spengler" vs profile "Egon
  // Spengler"), so the profile copy is preferred.
  const realName = profile.real_name || user.real_name || '';

  const pastDisplayNames = mergePast(previous?.pastDisplayNames, previous?.displayName, displayName);
  const pastRealNames = mergePast(previous?.pastRealNames, previous?.realName, realName);

  const person = {
    userId: user.id,
    realName,
    displayName,
    normalizedDisplayName:
      profile.display_name_normalized || normalizeName(displayName),
    normalizedRealName: profile.real_name_normalized || normalizeName(realName),
    handle: user.name || '',
    title: profile.title || '',
    // `deleted` may be absent entirely rather than false - Boolean() covers it.
    deleted: Boolean(user.deleted),
    // DO NOT add is_app_user here. Despite the name it means "is an
    // authorized user of the calling app", not "is an app" - including it
    // would drop any human who has authorized claudesington out of the
    // roster. Slackbot is the documented exception where is_bot is false, so
    // it's matched by ID.
    isBot: Boolean(user.is_bot) || user.id === 'USLACKBOT',
    // Guests are real people and stay in the roster; the flag is recorded
    // because it changes what they can be expected to know about.
    isGuest: Boolean(user.is_restricted || user.is_ultra_restricted),
    tz: user.tz || null,
    updated: user.updated || null,
    pastDisplayNames,
    pastRealNames,
  };

  person.preferredName = preferredName(person);
  person.aliases = buildAliases(person);
  return person;
}

// Keep a bounded history of names this person no longer uses.
function mergePast(existingPast, previousValue, currentValue) {
  const past = new Set(existingPast || []);
  if (previousValue && previousValue !== currentValue) {
    past.add(previousValue);
    console.log(`roster: name change detected - "${previousValue}" -> "${currentValue}"`);
  }
  past.delete(currentValue); // a name that is current again is not "past"
  return [...past].slice(-5);
}

function emptyRoster(channelId) {
  return { channelId, fetchedAt: null, memberCount: 0, people: [], unavailable: true };
}

async function saveRoster(channelId, roster) {
  try {
    if (kvAvailable) {
      await kv.set(`${ROSTER_PREFIX}${channelId}`, roster, { ex: 30 * 24 * 3600 });
    }
    memoryFallback.set(channelId, roster);
  } catch (e) {
    console.error(`roster: save failed for ${channelId}:`, e.message);
    memoryFallback.set(channelId, roster);
  }
}

// ---- test helpers ----
export function _resetRoster() {
  memoryFallback.clear();
}
