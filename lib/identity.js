// Identity resolution: turn "who is <@U09GGU5ED24>" / "who is sacha" /
// "who is Sacha Thompson-Sargoni" into the same person.
//
// THE BUG THIS REPLACES
// lib/parse.js rewrites <@U09GGU5ED24> to the literal string "@U09GGU5ED24"
// (Slack does not include a |label in modern mention payloads), and
// findMentionedTeammates then string-matched display names against that
// text. A raw user ID was being compared to a display name, so a tagged
// person never resolved. Verified against the live channel before this
// rewrite:
//
//   RAW    : <@U0AR6BMV46B> who is <@U09GGU5ED24>
//   CLEANED: @U0AR6BMV46B who is @U09GGU5ED24
//   MATCHED: (none)
//
// THE ORDER THAT FIXES IT
// Mention syntax is parsed from the RAW event text FIRST and resolved by
// exact user ID against the roster. That path is deterministic - no fuzzy
// matching is involved or needed. Only text that contains no tag falls
// through to name matching. A tag can never be wrong; a name can, so the
// certain signal has to be consumed before the uncertain one.

import { normalizeName, MIN_ALIAS_LENGTH } from './names.js';
import { humans, findById } from './roster.js';

// <@U012ABC> and the legacy <@U012ABC|label> form.
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
// <!subteam^S012ABC> / <!subteam^S012ABC|@handle>
const SUBTEAM_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g;
// <!here>, <!channel>, <!everyone>, and the <!here|here> variant.
const SPECIAL_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;

// ---- extraction ----

// Pull every mention out of RAW Slack text. Never operate on cleaned text -
// cleanSlackText destroys the syntax this depends on.
export function extractMentions(rawText, botUserId = '') {
  const result = { userIds: [], subteamIds: [], subteamHandles: [], specials: [], mentionsBot: false };
  if (!rawText) return result;

  for (const m of rawText.matchAll(USER_MENTION)) {
    const id = m[1];
    if (botUserId && id === botUserId) {
      result.mentionsBot = true;
      continue;
    }
    if (!result.userIds.includes(id)) result.userIds.push(id);
  }

  for (const m of rawText.matchAll(SUBTEAM_MENTION)) {
    if (!result.subteamIds.includes(m[1])) result.subteamIds.push(m[1]);
    if (m[2]) result.subteamHandles.push(m[2].replace(/^@/, ''));
  }

  for (const m of rawText.matchAll(SPECIAL_MENTION)) {
    if (!result.specials.includes(m[1])) result.specials.push(m[1]);
  }

  return result;
}

// Rewrite RAW text so mentions read as names before the model sees it.
// Replaces the bot's own mention with nothing (it's a trigger, not content)
// and every other <@U…> with "@Preferred Name". Anything the roster doesn't
// know keeps a readable placeholder instead of leaking a raw ID.
export function substituteMentions(rawText, roster, botUserId = '') {
  if (!rawText) return '';

  let out = rawText.replace(USER_MENTION, (full, id) => {
    if (botUserId && id === botUserId) return '';
    const person = findById(roster, id);
    // preferredName falls back to the userId when every name field is empty.
    // Emitting that would put a raw ID into the prompt and the channel log,
    // which is the thing this whole module exists to prevent.
    if (!person || looksLikeUserId(person.preferredName)) return '@someone';
    return `@${person.preferredName}`;
  });

  out = out.replace(SUBTEAM_MENTION, (full, id, handle) =>
    handle ? `@${handle.replace(/^@/, '')} (group)` : '@a group',
  );

  out = out.replace(SPECIAL_MENTION, (full, kind) => `@${kind}`);

  return out;
}

function looksLikeUserId(value) {
  return typeof value === 'string' && /^[UW][A-Z0-9]{7,12}$/.test(value);
}

// ---- name matching ----

// Which roster people are named in this text, by alias.
//
// Returns { matches, ambiguous }:
//  - matches: people matched unambiguously
//  - ambiguous: [{ alias, candidates }] where one typed name hit 2+ people.
//    The caller must ASK which one, never silently pick.
export function resolveByName(text, roster, { excludeUserId } = {}) {
  const result = { matches: [], ambiguous: [] };
  if (!text) return result;

  const haystack = normalizeName(stripNonProse(text));
  if (!haystack) return result;

  // alias -> [person, ...]
  const hitsByAlias = new Map();

  for (const person of humans(roster)) {
    if (excludeUserId && person.userId === excludeUserId) continue;
    for (const alias of person.aliases) {
      if (alias.length < MIN_ALIAS_LENGTH) continue;
      if (!containsWord(haystack, alias)) continue;
      if (!hitsByAlias.has(alias)) hitsByAlias.set(alias, []);
      const bucket = hitsByAlias.get(alias);
      if (!bucket.some((p) => p.userId === person.userId)) bucket.push(person);
    }
  }

  // A person matched by ANY unambiguous alias is a confident match. Only an
  // alias that maps to several different people is ambiguous, and only if
  // none of those people were also pinned down by a more specific alias -
  // "sacha thompson sargoni" resolving her makes a bare "sacha" moot.
  const confident = new Map();
  const contested = [];

  for (const [alias, people] of hitsByAlias) {
    if (people.length === 1) {
      confident.set(people[0].userId, people[0]);
    } else {
      contested.push({ alias, candidates: people });
    }
  }

  for (const { alias, candidates } of contested) {
    const alreadyResolved = candidates.filter((p) => confident.has(p.userId));
    // >= 1, not === 1. If EVERY candidate was pinned down by a more specific
    // alias ("tell me about alec sloan and alec moreno"), the bare "alec" is
    // not ambiguous - the user named them both. The old === 1 fell through and
    // asked "which alec do you mean" about a message that had already said.
    if (alreadyResolved.length >= 1) continue; // a longer alias settled it
    result.ambiguous.push({
      alias,
      candidates: candidates.map((p) => ({
        userId: p.userId,
        name: p.preferredName,
        title: p.title,
      })),
    });
  }

  result.matches = [...confident.values()];
  return result;
}

// Remove things that are not prose before name matching. normalizeName maps
// '.', '_', '-' and '/' to spaces, which turns a URL slug or an email local
// part into first+last name tokens: "notion.so/Alec-Sloan-1on1" matched Alec
// Sloan, and "alec.sloan@braintrust.dev" was even worse - it tripped the
// ambiguity gate and blocked the reply outright. A link is not someone
// mentioning a person.
function stripNonProse(text) {
  return text
    // Slack link syntax, with or without a label.
    .replace(/<https?:\/\/[^>]*>/gi, ' ')
    // Bare URLs, and bare domains with a path.
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+\.[a-z]{2,}\/\S*/gi, ' ')
    // Email addresses.
    .replace(/\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi, ' ');
}

// Word-boundary containment on already-normalized strings. A plain
// indexOf would match "ava" inside "available"; splitting into tokens and
// comparing windows avoids building a regex out of user-controlled text.
function containsWord(haystack, needle) {
  const hay = haystack.split(' ');
  const need = needle.split(' ');
  if (need.length === 1) {
    // Also accept the possessive. normalizeName strips the apostrophe, so
    // "who is sacha's manager" tokenizes to "sachas" and an exact-token match
    // missed it - and "who is X's manager" / "what's X's title" are the most
    // common person-lookup phrasings there are. This also covers the
    // apostrophe-less typo ("sachas out today").
    return hay.includes(need[0]) || hay.includes(`${need[0]}s`);
  }
  for (let i = 0; i + need.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < need.length; j++) {
      if (hay[i + j] !== need[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ---- unified entry point ----

// Resolve everyone referred to in a message.
//
// `taggedMatches` come from mention syntax and are authoritative.
// `nameMatches` come from fuzzy alias matching over the text that remains.
// `ambiguous` is non-empty only when a typed name genuinely maps to several
// people AND no tag settled it - the caller must ask.
export function resolvePeople({ rawText, roster, botUserId = '', excludeUserId } = {}) {
  const mentions = extractMentions(rawText, botUserId);

  const tagged = [];
  const unknownTags = [];
  for (const id of mentions.userIds) {
    const person = findById(roster, id);
    if (person) tagged.push(person);
    else unknownTags.push(id);
  }

  // Name matching runs on text with the tags already substituted, so a
  // tagged person's name is visible to the matcher too and the two paths
  // agree instead of double-reporting.
  const substituted = substituteMentions(rawText, roster, botUserId);
  const byName = resolveByName(substituted, roster, { excludeUserId });

  // Tag wins: drop any ambiguity that a tag in the same message resolved.
  const taggedIds = new Set(tagged.map((p) => p.userId));
  const ambiguous = byName.ambiguous.filter(
    (a) => !a.candidates.some((c) => taggedIds.has(c.userId)),
  );

  const all = new Map();
  for (const p of tagged) all.set(p.userId, { ...p, via: 'tag' });
  for (const p of byName.matches) if (!all.has(p.userId)) all.set(p.userId, { ...p, via: 'name' });

  return {
    people: [...all.values()],
    ambiguous,
    unknownTags,
    subteamIds: mentions.subteamIds,
    subteamHandles: mentions.subteamHandles,
    specials: mentions.specials,
    mentionsBot: mentions.mentionsBot,
    substitutedText: substituted,
  };
}

// ---- prompt rendering ----

// Grounded identity facts for the system prompt. Title comes straight from
// the Slack profile, so even a person with zero notes has one true thing the
// bot can say instead of "dunno".
export function identityToPromptContext(person) {
  const lines = [];
  const bits = [];
  if (person.title) bits.push(person.title);
  // Always emitted, present or not. Silence is what the model fills in with a
  // guess; an explicit "no pronoun data" is an instruction it can follow.
  bits.push(
    person.pronouns ? `pronouns ${person.pronouns}` : 'no pronoun data - use they/them',
  );
  if (person.realName && person.realName !== person.preferredName) {
    bits.push(`full name ${person.realName}`);
  }
  if (person.deleted) bits.push('no longer active in this workspace');
  if (bits.length) lines.push(`slack profile: ${bits.join(', ')}`);
  if (person.pastDisplayNames?.length) {
    lines.push(`previously went by: ${person.pastDisplayNames.join(', ')}`);
  }
  return lines.join('\n');
}

// The question the bot asks when a name is ambiguous. Never pick one.
export function ambiguityPrompt(ambiguous) {
  if (!ambiguous?.length) return null;
  const first = ambiguous[0];
  const names = first.candidates.map((c) => (c.title ? `${c.name} (${c.title})` : c.name));
  const last = names.pop();
  return `which ${first.alias} do you mean, ${names.join(', ')} or ${last}?`;
}
