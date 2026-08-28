// Phase 2: kill the blank "dunno".
//
// THE FAILURE, observed in the real channel:
//
//   you:  "do you remebr him <@Claudesington>?"
//   bot:  "which \"him\" are we talking about? let me know who you mean."
//   you:  "joey"
//   bot:  "i'm not sure who Joey is - maybe try pinging the team or asking
//          Maddy Ahlborn for the scoop."
//
// Two things wrong there. The bot declined without offering anything it
// actually had, and then invented a referral - Maddy Ahlborn has no
// established connection to Joey, the model just needed a name to point at.
//
// THE RULE
// If we loaded grounded facts about a person and the model still returns a bare
// deflection, that is a floor violation: it had something to say and said
// nothing. It must instead say plainly that it doesn't know the specific thing
// asked, then offer what it does have. It must never invent the missing fact.
//
// WHY A CODE GUARD AND NOT JUST A PROMPT
// prompts/system.js has told the model not to do this since before this
// session, in several places and in capital letters, and it still does it. A
// prompt is a request; this is a check. Same reasoning as lib/guardrails.js.
// The prompt change ships alongside this - both, because the prompt gets the
// good answer most of the time and this catches the rest.

// A reply that declines. Deliberately broad: this only fires when we ALSO know
// the reply offered nothing, so a false positive here is harmless.
const DEFLECTION_PATTERNS = [
  /\bi (?:don'?t|do not) (?:know|have|see)\b/i,
  /\bi'?m not sure\b/i,
  /\bnot sure (?:who|what|which|on|about)\b/i,
  /\bno idea\b/i,
  /\bcan'?t (?:help|say|tell|find|check)\b/i,
  /\bcannot (?:help|say|tell|find)\b/i,
  /\bnothing (?:on|about|for) (?:that|them|him|her)\b/i,
  /\bdon'?t have (?:that|anything|any info)\b/i,
  /\bnever heard of\b/i,
  /\bwho'?s that\b/i,
  /\bdoesn'?t ring a bell\b/i,
  /\bcouldn'?t find\b/i,
];

// A referral the model invents to look helpful. "ask <person>" is fine when
// that person is actually connected to the question, but the model reaches for
// a random roster name, which reads as knowledge and is not.
const INVENTED_REFERRAL = /\b(?:ask|ping|check with|reach out to|talk to)\s+(?!me\b)[A-Z][a-z]+/;

// Words too common to prove a reply actually used a fact.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','was','are','were','be','been','to','of',
  'in','on','at','for','with','from','by','it','its','this','that','they','them',
  'their','he','she','his','her','you','your','i','we','our','has','have','had',
  'not','no','yes','do','does','did','so','if','as','about','into','over','also',
  'known','team','channel','slack','profile','notes','note','life','sdr','rep',
]);

function distinctiveTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

// Did the reply actually surface any of the facts we handed it? Overlap on a
// distinctive token is a low bar on purpose - we are only distinguishing "said
// something" from "said nothing".
export function offersSomething(reply, factsText) {
  const factTokens = distinctiveTokens(factsText);
  if (factTokens.size === 0) return true; // nothing to offer, so nothing withheld
  const replyTokens = distinctiveTokens(reply);
  for (const t of replyTokens) {
    if (factTokens.has(t)) return true;
  }
  return false;
}

export function isDeflection(reply) {
  if (!reply) return true;
  return DEFLECTION_PATTERNS.some((re) => re.test(reply));
}

export function hasInventedReferral(reply) {
  return INVENTED_REFERRAL.test(reply || '');
}

// Turn a facts block into one short spoken clause, in voice.
//
// The facts arrive as prompt lines like:
//   slack profile: Sales Development Representative, full name Alec Sloan
//   known from the team channel: dry humor; likes PC hardware
//   life notes: left the company (~Aug 12)
// Life notes are deliberately EXCLUDED here. They are facts to state plainly if
// someone asks, never volunteered - see the departure guardrail. Offering "what
// I do have" must not become a way to announce that somebody left.
export function summarizeFacts(factsText) {
  const bits = [];
  for (const rawLine of String(factsText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('life notes')) continue; // never volunteered
    if (lower.startsWith('previously went by')) continue; // not interesting unprompted

    const value = line.replace(/^[^:]*:\s*/, '').trim();
    if (!value) continue;

    if (lower.startsWith('slack profile')) {
      // Drop the pronoun bookkeeping - it is an instruction to the model, not
      // something to read out to a person.
      const cleaned = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !/^(pronouns|no pronoun data)/i.test(s))
        .join(', ');
      if (cleaned) bits.push(cleaned.toLowerCase());
    } else {
      bits.push(value.toLowerCase());
    }
  }
  return bits;
}

// The floor.
//
// people: [{ name, facts }] - the same shape api/slack-events.js builds.
// Returns { reply, applied, reason }.
export function enforceAnswerFloor({ reply, people = [] } = {}) {
  const withFacts = people.filter((p) => p && p.facts && p.facts.trim());

  // No grounded facts loaded means there is no floor to enforce. "i don't know
  // who that is" is the CORRECT answer for an unknown person, and this must
  // never manufacture knowledge to avoid saying it.
  if (withFacts.length === 0) {
    return { reply, applied: false, reason: 'no_facts_loaded' };
  }

  const deflected = isDeflection(reply);
  const offered = offersSomething(reply, withFacts.map((p) => p.facts).join('\n'));
  const invented = hasInventedReferral(reply);

  if (!deflected && !invented) {
    return { reply, applied: false, reason: 'reply_is_substantive' };
  }
  if (deflected && offered && !invented) {
    // Declined the specific thing but did surface something. That is exactly
    // the behaviour we want; leave it alone.
    return { reply, applied: false, reason: 'deflected_but_offered' };
  }

  // Floor violation. Rebuild: acknowledge the gap, then offer what we have.
  const parts = [];
  for (const person of withFacts) {
    const bits = summarizeFacts(person.facts);
    if (bits.length === 0) continue;
    parts.push(`${person.name.toLowerCase()}: ${bits.join('. ')}`);
  }

  if (parts.length === 0) {
    // Facts existed but were all life notes / non-volunteerable. Don't
    // fabricate a substitute; the deflection stands.
    return { reply, applied: false, reason: 'facts_not_volunteerable' };
  }

  const rebuilt = `don't have that specific thing. what i do have, ${parts.join(' | ')}`;

  return {
    reply: rebuilt,
    applied: true,
    reason: invented && !deflected ? 'invented_referral' : 'bare_deflection',
    original: reply,
  };
}

// ---------------------------------------------------------------------------
// pronoun guard
// ---------------------------------------------------------------------------
//
// The prompt already says "pronouns are a FACT, not a guess... if none are
// given, say they". It is not enough. Real output from the live path, for a
// person with no pronoun data on file:
//
//   "alec's a Sales Development Representative on the team. HE'S the guy who
//    still runs a 1080ti at home and always orders the same steak wrap"
//
// So: a code guard, same reasoning as enforceAnswerFloor. Only applies when
// EVERY person referenced in the reply has no pronoun data - if any of them
// published pronouns, rewriting is riskier than leaving it, because we cannot
// tell which pronoun belongs to whom.
const PRONOUN_REWRITES = [
  [/\bhe's\b/gi, "they're"],
  [/\bshe's\b/gi, "they're"],
  [/\bhe is\b/gi, 'they are'],
  [/\bshe is\b/gi, 'they are'],
  [/\bhe was\b/gi, 'they were'],
  [/\bshe was\b/gi, 'they were'],
  [/\bhe has\b/gi, 'they have'],
  [/\bshe has\b/gi, 'they have'],
  [/\bhe does\b/gi, 'they do'],
  [/\bshe does\b/gi, 'they do'],
  [/\bhis own\b/gi, 'their own'],
  [/\bher own\b/gi, 'their own'],
  [/\bhimself\b/gi, 'themselves'],
  [/\bherself\b/gi, 'themselves'],
  [/\bhers\b/gi, 'theirs'],
  [/\bhis\b/gi, 'their'],
  [/\bhim\b/gi, 'them'],
  // `her` is both object and possessive; `their` is right for the possessive
  // and `them` for the object. Possessive is far more common in this shape
  // ("her lunch order"), so prefer it and accept the occasional miss.
  [/\bher\b/gi, 'their'],
  [/\bhe\b/gi, 'they'],
  [/\bshe\b/gi, 'they'],
];

export function hasGenderedPronoun(text) {
  return /\b(he|him|his|himself|she|her|hers|herself)\b/i.test(text || '');
}

// people: [{ name, pronouns }]. Returns { reply, applied, rewrites }.
export function enforcePronouns({ reply, people = [] } = {}) {
  if (!reply || !hasGenderedPronoun(reply)) {
    return { reply, applied: false, rewrites: 0 };
  }
  if (people.length === 0) {
    // Nobody identified, so there is no pronoun claim to check against. A
    // gendered pronoun here is probably about the sender or a third party we
    // know nothing about; leave it.
    return { reply, applied: false, rewrites: 0 };
  }
  const anyPublished = people.some((p) => p && p.pronouns && String(p.pronouns).trim());
  if (anyPublished) {
    return { reply, applied: false, rewrites: 0, reason: 'someone_published_pronouns' };
  }

  let out = reply;
  let rewrites = 0;
  for (const [re, replacement] of PRONOUN_REWRITES) {
    out = out.replace(re, (m) => {
      rewrites += 1;
      // Preserve a leading capital.
      return m[0] === m[0].toUpperCase()
        ? replacement[0].toUpperCase() + replacement.slice(1)
        : replacement;
    });
  }
  return { reply: out, applied: rewrites > 0, rewrites };
}
