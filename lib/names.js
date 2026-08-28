// Name normalization shared by the roster and the identity resolver.
// Kept in its own module so the exact same normalization is applied to both
// sides of every comparison - a mismatch here is invisible and produces
// "the bot doesn't know who that is" with no error anywhere.

// Lowercase, strip diacritics, turn handle separators into spaces, drop
// everything that isn't a letter/digit/space, collapse whitespace.
//
//   "Evan O'Reilly"        -> "evan oreilly"
//   "evan.oreilly"         -> "evan oreilly"
//   "Sacha Thompson-Sargoni" -> "sacha thompson sargoni"
//
// Note the handle and the real name converge on the same string, which is
// what lets a tag, a handle, and a typed name all hit the same person.
export function normalizeName(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks left by NFKD
    .toLowerCase()
    .replace(/[._\-/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Aliases shorter than this are too collision-prone to match on. "al" would
// fire inside "also"; word boundaries don't save you from real two-letter
// words. Three is enough for every real first name we have.
export const MIN_ALIAS_LENGTH = 3;

// Common words that must never become a single-token alias. A display name
// like "Big Al" would otherwise contribute the alias "big" and match "big
// win" as a person. Only applied to SINGLE-token aliases - the full name
// "big al" stays matchable, and a real first name is never on this list.
const ALIAS_STOPWORDS = new Set([
  'the', 'and', 'not', 'you', 'your', 'all', 'any', 'one', 'two', 'new', 'old',
  'big', 'top', 'out', 'off', 'for', 'was', 'are', 'has', 'had', 'can', 'did',
  'yes', 'nah', 'hey', 'yay', 'lol', 'bot', 'app', 'dev', 'ops', 'eng',
  'sdr', 'sales', 'team', 'guy', 'man', 'kid', 'boss', 'admin', 'test',
  'day', 'now', 'who', 'why', 'how', 'get', 'got', 'let', 'see', 'say',
]);

// Every string this person could reasonably be called, normalized.
//
// Deliberately EXCLUDES surname-only ("belza", "sloan"). Surnames collide
// with ordinary words and with each other far more than first names do, and
// nobody in this channel refers to teammates by surname alone. If that
// changes, add it as a separate lower-confidence tier rather than mixing it
// in here.
export function buildAliases(person) {
  const out = new Set();

  const add = (value) => {
    const n = normalizeName(value);
    if (n.length >= MIN_ALIAS_LENGTH) out.add(n);
    // First token as well: "kensington belza" -> "kensington". Skipped when
    // it's a common word, so "Big Al" doesn't make "big" a person.
    const first = n.split(' ')[0];
    if (
      first &&
      first.length >= MIN_ALIAS_LENGTH &&
      !ALIAS_STOPWORDS.has(first)
    ) {
      out.add(first);
    }
  };

  add(person.realName);
  add(person.displayName);
  add(person.handle);
  for (const past of person.pastDisplayNames || []) add(past);
  for (const past of person.pastRealNames || []) add(past);

  return [...out];
}

// Human-readable name, following Slack's own guidance: display_name when the
// user set one, otherwise real_name, otherwise the handle. 3 of 13 humans in
// this channel have an empty display_name, so the fallback is load-bearing,
// not defensive padding.
export function preferredName(person) {
  return (
    person.displayName ||
    person.realName ||
    person.handle ||
    person.userId ||
    'unknown'
  );
}
