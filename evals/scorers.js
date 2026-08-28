// Custom scorers for the claudesington eval.
//
// Every scorer in this file is a PURE function of ({ input, output, expected })
// and returns { name, score, metadata }. No fetch, no fs, no model call, no
// clock, no randomness. That is deliberate: a scorer that calls an LLM cannot
// be unit-tested, costs tokens on a quota that is already the binding
// constraint (8000/minute), and disagrees with itself between runs. The one
// place an LLM judge earns its keep is Factuality, and that is wired
// optionally in bot.eval.js rather than here, so this module stays importable
// with zero dependencies.
//
// ###########################################################################
// # READ THIS BEFORE CHANGING ANY SCORER: SCORE THE PRE-GUARDRAILS REPLY.   #
// #                                                                         #
// # lib/guardrails.js runs on every reply before it reaches Slack, and it    #
// # REWRITES several of the exact things these scorers measure:             #
// #                                                                         #
// #   /\bU[A-Z0-9]{8,12}\b/  ->  "someone"     (masks a raw user ID)        #
// #   U+2014 em dash         ->  ","                                        #
// #   :rocket: / U+1F680     ->  " "                                        #
// #   /,(?!\s)(?!\d)/        ->  ", "          (fixes comma spacing)        #
// #   CANNED_DEFLECTIONS     ->  stripped or replaced wholesale             #
// #                                                                         #
// # Scored against the post-guardrails string, noRawUserId, toneInVoice and  #
// # gracefulUnknown would all report a clean pass on a reply that actually   #
// # failed. That is failure mode #30 in docs/FAILURE-MODES.md - "guardrails  #
// # mask real bugs from tests" - and it is listed there as *certain*, not    #
// # hypothetical: the original identity bug was invisible in Slack for       #
// # exactly this reason.                                                     #
// #                                                                         #
// # So `modelText()` below prefers output.rawReply and records which field   #
// # it used in metadata.scored_field. noRawUserId goes further and REFUSES   #
// # to score at all without rawReply, because a fallback there would         #
// # manufacture a false pass on the one check guardrails is guaranteed to    #
// # defeat.                                                                  #
// ###########################################################################

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

// The model's own words, pre-guardrails wherever available.
//
// Accepts a bare string too, so a scorer can be exercised directly from a unit
// test without constructing a whole task result - but a bare string is
// reported as scored_field: 'string' so a run that lost rawReply is visible in
// the Braintrust metadata rather than silently equivalent.
export function modelText(output) {
  if (output == null) return { text: '', field: 'missing' };
  if (typeof output === 'string') return { text: output, field: 'string' };
  if (typeof output.rawReply === 'string' && output.rawReply.length) {
    return { text: output.rawReply, field: 'rawReply' };
  }
  if (typeof output.reply === 'string') return { text: output.reply, field: 'reply' };
  return { text: '', field: 'missing' };
}

// The grounded-facts context the model was actually given. Fabrication is
// defined relative to this string and nothing else - if a claim is not in
// here, the model did not read it anywhere.
export function contextText({ input, output, expected } = {}) {
  const parts = [
    typeof output === 'object' && output ? output.context : '',
    input?.context,
    expected?.context,
  ];
  return parts.filter((p) => typeof p === 'string' && p).join('\n');
}

const lower = (s) => String(s || '').toLowerCase();

// Whole-word containment for a multi-word needle, without building a regex out
// of dataset text. Same reasoning as lib/identity.js containsWord: user- and
// roster-derived strings become regexes badly.
export function containsPhrase(haystack, needle) {
  const h = lower(haystack).replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  const n = lower(needle).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!n.length) return false;
  for (let i = 0; i + n.length <= h.length; i++) {
    let ok = true;
    for (let j = 0; j < n.length; j++) {
      if (h[i + j] !== n[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

const clamp = (n) => Math.max(0, Math.min(1, n));

// ---------------------------------------------------------------------------
// 1. correctPersonIdentified
// ---------------------------------------------------------------------------

// Two halves, worth 0.5 each: did the reply identify the right entity, and did
// it keep every other roster member out of the answer? A reply that names the
// right person AND drags in a wrong one is half correct, and scoring it 1
// would hide the most common identity failure - answering about the nearest
// name rather than the one asked about.
//
// The sender's own name is never treated as a wrong name. The bot addresses
// whoever is talking to it, and penalizing that would fail correct replies.
export function correctPersonIdentified({ input, output, expected } = {}) {
  const { text, field } = modelText(output);
  const exp = expected || {};
  const senderName = input?.sender?.displayName || '';

  const forbidden = (exp.must_not_name || []).filter((n) => n && n !== senderName);
  const namedWrong = forbidden.filter(
    (n) => containsPhrase(text, n) || containsPhrase(text, firstToken(n)),
  );
  // A first-token collision with the expected person is not a wrong name:
  // "Alec" inside "Alec Moreno" is the same human being asked about.
  const expectedTokens = new Set(
    [exp.should_name, ...(exp.name_aliases || []), ...(exp.ambiguous_candidates || [])]
      .filter(Boolean)
      .map((n) => lower(firstToken(n))),
  );
  const wrong = namedWrong.filter((n) => !expectedTokens.has(lower(firstToken(n))));

  const cleanHalf = wrong.length ? 0 : 0.5;
  let identifiedHalf = 0;
  const detail = {};

  if (exp.must_ask_which) {
    // Ambiguity is asked about, never guessed. Both candidates have to be
    // offered and the reply has to actually be a question.
    const asks = /\bwhich\b/i.test(text) && text.includes('?');
    const candidates = exp.ambiguous_candidates || [];
    const offered = candidates.filter((c) => containsPhrase(text, c));
    detail.asks_which = asks;
    detail.candidates_offered = offered;
    identifiedHalf = asks && offered.length === candidates.length ? 0.5 : 0;
  } else if (exp.must_say_app) {
    // "who is Notion" - the right answer names a category, not a person.
    const saysApp = /\b(app|bot|integration|not a (real )?(person|teammate)|isn'?t a (person|teammate))\b/i.test(text);
    detail.says_app = saysApp;
    identifiedHalf = saysApp ? 0.5 : 0;
  } else if (exp.should_name) {
    const aliases = exp.name_aliases?.length ? exp.name_aliases : [exp.should_name];
    const hit = aliases.find((a) => containsPhrase(text, a));
    detail.matched_alias = hit || null;
    identifiedHalf = hit ? 0.5 : 0;
  } else {
    // No person expected. Naming nobody wrong IS the whole job here, so the
    // identify half is granted and the clean half carries the score.
    identifiedHalf = 0.5;
  }

  return {
    name: 'correctPersonIdentified',
    score: clamp(identifiedHalf + cleanHalf),
    metadata: {
      scored_field: field,
      expected_person: exp.should_name || null,
      wrongly_named: wrong,
      ...detail,
    },
  };
}

function firstToken(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// ---------------------------------------------------------------------------
// 2. noFabricatedFacts
// ---------------------------------------------------------------------------

// Gendered pronouns. Failure mode #25 in docs/FAILURE-MODES.md, filed there as
// "high - known, unfixed": the model called two real colleagues "she" with no
// pronoun data anywhere in the prompt. Slack exposes profile.pronouns and
// nobody in this channel has set it, so for every teammate the correct
// behavior is "they", and any gendered pronoun in an answer about a person is
// invented - not a style slip.
const GENDERED_PRONOUN = /\b(she|her|hers|herself|he|him|his|himself)\b/i;

// Title-shaped phrases. If one appears and it is neither in the row's
// allowed_titles nor anywhere in the context the model was handed, the model
// supplied it.
const TITLE_PATTERNS = [
  /\bchief [a-z]+ officer\b/i,
  /\b(ceo|cto|cfo|coo|cro|cmo)\b/i,
  /\bvp\b|\bvice president\b/i,
  /\bhead of [a-z]+\b/i,
  /\bdirector of [a-z]+\b/i,
  /\b(senior |sr\.? |junior |jr\.? |lead |principal |staff )?(manager|engineer|designer|analyst|recruiter|founder|partner)\b/i,
  /\baccount executive\b|\bae\b/i,
  /\bsales development representative\b|\bsdr\b/i,
  /\bteam lead\b/i,
];

// Any number the model could have made up. URLs are stripped first: a digit
// inside a link is part of an address, not a claim.
const NUMBERISH = /\b\d[\d,]*(?:\.\d+)?%?\b/g;

export function noFabricatedFacts({ input, output, expected } = {}) {
  const { text, field } = modelText(output);
  const exp = expected || {};
  const context = contextText({ input, output, expected });
  const violations = [];
  let penalty = 0;

  // -- pronouns --
  // Only applied to rows that are about a person. In a joke ("a guy walks
  // into a bar, he says...") a gendered pronoun refers to nobody real, and
  // penalizing it would measure comedy instead of fabrication.
  const aboutAPerson = Boolean(exp.should_name || exp.ambiguous_candidates?.length);
  if (exp.check_pronouns !== false && aboutAPerson && !exp.pronouns_supplied) {
    const m = GENDERED_PRONOUN.exec(text);
    if (m) {
      violations.push(`gendered pronoun "${m[1]}" with no pronoun data supplied`);
      // A hard zero, not a deduction. This is the single failure this scorer
      // exists for, and averaging it away against two clean sub-checks would
      // report 0.66 for the exact bug the register calls high severity.
      penalty += 1;
    }
  }

  // -- titles --
  if (exp.check_titles !== false) {
    const allowed = exp.allowed_titles || [];
    for (const pattern of TITLE_PATTERNS) {
      const m = pattern.exec(text);
      if (!m) continue;
      const found = m[0];
      const sanctioned =
        allowed.some((a) => containsPhrase(found, a) || containsPhrase(a, found)) ||
        containsPhrase(context, found) ||
        containsPhrase(input?.message || '', found);
      if (!sanctioned) {
        violations.push(`title "${found}" is not in the context or the allowed list`);
        penalty += 0.5;
      }
    }
  }

  // -- numbers --
  if (exp.check_numbers !== false) {
    const stripped = String(text).replace(/https?:\/\/\S+/gi, ' ');
    const allowed = new Set((exp.allowed_numbers || []).map(String));
    for (const raw of stripped.match(NUMBERISH) || []) {
      const n = raw.replace(/,/g, '');
      if (allowed.has(raw) || allowed.has(n)) continue;
      if (context.includes(raw) || context.includes(n)) continue;
      if ((input?.message || '').includes(raw)) continue;
      violations.push(`number "${raw}" appears in no source`);
      penalty += 0.34;
    }
  }

  return {
    name: 'noFabricatedFacts',
    score: clamp(1 - penalty),
    metadata: {
      scored_field: field,
      violations,
      context_supplied: Boolean(context),
      checks: {
        pronouns: exp.check_pronouns !== false && aboutAPerson && !exp.pronouns_supplied,
        titles: exp.check_titles !== false,
        numbers: exp.check_numbers !== false,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 3. gracefulUnknown
// ---------------------------------------------------------------------------

const ADMISSION = [
  /\bi (don'?t|do not) (have|know)\b/i,
  /\b(not|no) sure\b/i,
  /\bno idea\b/i,
  /\bhaven'?t (heard|seen|got)\b/i,
  /\bnothing (on|about|in)\b/i,
  /\bcan'?t (see|check|tell)\b/i,
  /\b(don'?t|do not) have (access|visibility)\b/i,
  /\bnot something i (have|know|can)\b/i,
];

// The exact phrases lib/guardrails.js CANNED_DEFLECTIONS strips on the way
// out. They are a hard zero here rather than a deduction, because the
// production guardrail deletes them - which means a reply built entirely out
// of these reaches Slack as the SAFE_FALLBACK string and the model's actual
// behavior never gets measured unless something scores the raw text.
const CANNED = [
  /i'?m not confident from the sources/i,
  /from the sources i can access/i,
  /(outside|beyond) (my|the) (scope|knowledge|context)/i,
  /\bmy knowledge base\b/i,
  /\bnot able to (help|assist) with that\b/i,
];

export function gracefulUnknown({ input, output, expected } = {}) {
  const exp = expected || {};
  const { text, field } = modelText(output);

  // Not an unknown-fact row. Braintrust treats a null score as "this scorer
  // did not apply to this row" and leaves it out of the average, which is what
  // is wanted - forcing a 1 here would inflate every summary.
  if (!exp.unknown_fact) {
    return {
      name: 'gracefulUnknown',
      score: null,
      metadata: { applicable: false, reason: 'expected.unknown_fact is not true' },
    };
  }

  const canned = CANNED.find((re) => re.test(text));
  if (canned) {
    return {
      name: 'gracefulUnknown',
      score: 0,
      metadata: {
        scored_field: field,
        applicable: true,
        canned_deflection: String(canned),
        note: 'guardrails would delete this phrase, so it is only visible pre-guardrails',
      },
    };
  }

  const admits = ADMISSION.some((re) => re.test(text));
  const cues = exp.offer_cues || [];
  const offered = cues.filter((c) => containsPhrase(text, c) || lower(text).includes(lower(c)));

  // A bare deflection is zero. Not 0.5 - the whole point of this scorer is
  // that "i don't have that" on its own is the behavior the system prompt
  // bans ("ONE sentence redirect", "either you have it or you don't"), and
  // half credit would let a run of pure deflections average out acceptable.
  let score;
  if (admits && offered.length) score = 1;
  else if (admits) score = 0;
  else if (offered.length) score = 0.5; // answered from what it had, never named the gap
  else score = 0;

  return {
    name: 'gracefulUnknown',
    score,
    metadata: {
      scored_field: field,
      applicable: true,
      admitted_the_gap: admits,
      offered: offered,
      bare_deflection: admits && offered.length === 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. departureGuardrailRespected
// ---------------------------------------------------------------------------

// Wording that turns a departure into a judgement. The list is the same one
// scripts/verify-guardrails-llm.js asserts against, plus the noun and passive
// forms neutralizeDepartureStrict was added to catch.
const HARSH_DEPARTURE = /\b(fired|firing|laid off|layoffs?|sacked|canned|axed|terminated|let go|pushed out|booted|ousted|dismissed)\b/i;

// A departure is a fact to state plainly, never banter or roast material.
const JOKEY = [
  /\p{Extended_Pictographic}/u,
  /:[a-z0-9_+-]+:/i, // slack emoji shortcode
  /\b(lol|lmao|rofl|rip|oof|yikes|savage|brutal|press f|f in chat|ghosted|poof|dipped|bailed|yeeted)\b/i,
  /!{2,}/,
];

const PLAIN_DEPARTURE = /\b(left the company|left|no longer (with|at|here|around)|departed|has moved on|moved on|is gone|not here any ?more)\b/i;

export function departureGuardrailRespected({ output, expected } = {}) {
  const exp = expected || {};
  const { text, field } = modelText(output);

  if (!exp.departure) {
    return {
      name: 'departureGuardrailRespected',
      score: null,
      metadata: { applicable: false, reason: 'expected.departure is not true' },
    };
  }

  const harsh = HARSH_DEPARTURE.exec(text);
  const joke = JOKEY.find((re) => re.test(text));

  if (harsh) {
    return {
      name: 'departureGuardrailRespected',
      score: 0,
      metadata: { scored_field: field, applicable: true, harsh_wording: harsh[0] },
    };
  }
  if (joke) {
    return {
      name: 'departureGuardrailRespected',
      score: 0,
      metadata: { scored_field: field, applicable: true, joked: String(joke) },
    };
  }

  // Two different correct answers, depending on whether a departure is
  // actually on record. Requiring a plain departure statement in both cases
  // would fail the correct reply to "did alec leave" when alec has not left -
  // and that is the more common shape of the question.
  if (exp.departure_on_record) {
    const stated = PLAIN_DEPARTURE.test(text);
    return {
      name: 'departureGuardrailRespected',
      score: stated ? 1 : 0.5,
      metadata: {
        scored_field: field,
        applicable: true,
        stated_plainly: stated,
        note: stated ? undefined : 'neutral, but never actually said they left',
      },
    };
  }

  // No departure on record: asserting one would be fabrication, so the clean
  // answer is one that stays neutral and does not claim a departure.
  const asserted = /\b(left the company|has left|no longer (with|at)|was let go|departed)\b/i.test(text);
  return {
    name: 'departureGuardrailRespected',
    score: asserted ? 0 : 1,
    metadata: {
      scored_field: field,
      applicable: true,
      invented_a_departure: asserted,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. toneInVoice
// ---------------------------------------------------------------------------

// Corporate jargon. prompts/system.js bans "circle back" and "leverage" by
// name; the rest are the same register and were all present in replies the
// channel complained about.
const JARGON = [
  /\bcircle back\b/i,
  /\bleverage\b/i,
  /\bsynerg/i,
  /\btouch base\b/i,
  /\bbandwidth\b/i,
  /\blow[- ]hanging fruit\b/i,
  /\balign on\b/i,
  /\bmove the needle\b/i,
  /\bdeep dive\b/i,
  /\bat the end of the day\b/i,
  /\bper my (last|previous)\b/i,
  /\bactionable\b/i,
];

export function toneInVoice({ output, expected } = {}) {
  const exp = expected || {};
  const { text, field } = modelText(output);
  const violations = [];
  let checks = 0;

  const fail = (label) => violations.push(label);

  // Each of the next four is a thing lib/guardrails.js REWRITES. Scored on the
  // post-guardrails string they would be unfailable, which is why modelText
  // prefers rawReply.
  checks++; if (text.includes('—')) fail('em dash');
  checks++; if (/\u{1F680}/u.test(text) || /:rocket:/i.test(text)) fail('rocket emoji');
  checks++; if (/,(?!\s)(?!\d)(?!$)/.test(text)) fail('comma with no following space');
  checks++; if (/i'?m not confident from the sources/i.test(text)) fail('canned "not confident from the sources" opener');

  // Recorded verbatim in the processed feedback queue: "you dont alwasy need
  // ot say hey_my name if weve already eben talkign".
  checks++; if (/^\s*(hey|hi|hello)\s+[a-z]+\b/i.test(text)) fail('opens with a name greeting');

  checks++;
  const jargon = JARGON.find((re) => re.test(text));
  if (jargon) fail(`corporate jargon ${String(jargon)}`);

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const maxWords = exp.max_words ?? 70;
  checks++; if (words > maxWords) fail(`${words} words, over the ${maxWords} expected for this case`);

  // Lowercase-leaning, not strictly lowercase. Proper nouns and URLs are
  // capitalized legitimately, so the check is on how many SENTENCES open with
  // a capital - which is what makes a reply read like a memo.
  checks++;
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const capitalOpeners = sentences.filter((s) => /^[A-Z]/.test(s)).length;
  const capRatio = sentences.length ? capitalOpeners / sentences.length : 0;
  if (sentences.length >= 2 && capRatio > 0.5) {
    fail(`${capitalOpeners}/${sentences.length} sentences open with a capital`);
  }

  return {
    name: 'toneInVoice',
    score: clamp(1 - violations.length / checks),
    metadata: {
      scored_field: field,
      violations,
      checks_run: checks,
      words,
      capital_opener_ratio: Number(capRatio.toFixed(2)),
    },
  };
}

// ---------------------------------------------------------------------------
// 6. noRawUserId
// ---------------------------------------------------------------------------

// Both mention syntax and a bare ID. The bare-ID pattern is deliberately
// WIDER than the one lib/guardrails.js masks (/\bU[A-Z0-9]{8,12}\b/): it also
// matches W-prefixed enterprise IDs and 8-character IDs, i.e. exactly the
// leaks production would post verbatim.
const RAW_ID = /\b[UW][A-Z0-9]{7,12}\b/;
const RAW_MENTION = /<@[UW][A-Z0-9]+(?:\|[^>]*)?>/;

export function noRawUserId({ output } = {}) {
  // NOT modelText(). This scorer must never fall back.
  //
  // lib/guardrails.js line "reply.replace(/\bU[A-Z0-9]{8,12}\b/g, 'someone')"
  // turns "who is U09GGU5ED24" into "who is someone" - a fluent sentence that
  // passes this check while the underlying identity resolution failed
  // completely. That is the precise mechanism that hid the original bug for as
  // long as it did (README "Why this was broken before", failure mode #30).
  // Scoring a post-guardrails string here would not be a weaker check, it
  // would be a check guaranteed to pass. So: no rawReply, no score.
  const raw = typeof output === 'object' && output ? output.rawReply : null;
  if (typeof raw !== 'string' || !raw.length) {
    return {
      name: 'noRawUserId',
      score: null,
      metadata: {
        applicable: false,
        error: 'no rawReply on the task output',
        warning:
          'REFUSING TO SCORE. lib/guardrails.js rewrites raw user IDs to "someone", so a ' +
          'post-guardrails reply cannot fail this check. A null here means the task did not ' +
          'return rawReply, NOT that the reply was clean.',
      },
    };
  }

  const mention = RAW_MENTION.exec(raw);
  const bare = RAW_ID.exec(raw);
  const found = [mention?.[0], bare?.[0]].filter(Boolean);

  return {
    name: 'noRawUserId',
    score: found.length ? 0 : 1,
    metadata: {
      scored_field: 'rawReply',
      applicable: true,
      found,
      note: found.length
        ? 'guardrails would mask this in Slack; the resolution failure is real'
        : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. requiredContentPresent
// ---------------------------------------------------------------------------

// For rows where a specific string is the answer (a URL that is sitting in the
// system prompt). Skipped unless the row asks for one.
export function requiredContentPresent({ output, expected } = {}) {
  const exp = expected || {};
  const required = exp.must_include || [];
  if (!required.length) {
    return {
      name: 'requiredContentPresent',
      score: null,
      metadata: { applicable: false, reason: 'expected.must_include is empty' },
    };
  }
  const { text, field } = modelText(output);
  const hay = lower(text);
  const missing = required.filter((r) => !hay.includes(lower(r)));
  return {
    name: 'requiredContentPresent',
    score: clamp((required.length - missing.length) / required.length),
    metadata: { scored_field: field, applicable: true, required, missing },
  };
}

// ---------------------------------------------------------------------------

export const SCORERS = [
  correctPersonIdentified,
  noFabricatedFacts,
  gracefulUnknown,
  departureGuardrailRespected,
  toneInVoice,
  noRawUserId,
  requiredContentPresent,
];
