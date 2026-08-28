// Eval dataset: real channel questions, and what a correct reply looks like.
//
// PROVENANCE MATTERS MORE THAN COVERAGE HERE. A synthetic dataset measures
// how the bot handles questions nobody asked. Every row carries
// `metadata.provenance`:
//   'observed'    - the exact string was asked in the real channel or is
//                   recorded in this repo (a processed feedback transcript,
//                   the ambient channel log, a documented relay example).
//   'constructed' - written to cover a case type that has no recorded example
//                   yet. There are three, and they say so.
// `metadata.source` names where an observed row came from, so a row can be
// re-checked against the artifact instead of trusted.
//
// `input.message` is RAW SLACK TEXT, not cleaned text. Identity resolution
// reads the raw event text on purpose - lib/parse.js rewrites <@U09GGU5ED24>
// to the literal "@U09GGU5ED24", and matching a display name against a user
// ID is the original bug lib/identity.js exists to fix. A dataset that stored
// cleaned text could not exercise the tag path at all.
//
// This module is pure data plus pure functions. No fetch, no fs, no KV. The
// roster fixture is stored as RAW Slack user objects (the shape users.info
// returns) rather than as finished person records, so the eval runs them
// through the real `buildPerson` from lib/roster.js and any change to name
// preference, alias building or pronoun carrying is reflected here for free.

// ---------------------------------------------------------------------------
// Roster fixture
// ---------------------------------------------------------------------------

// Copied from the recorded roster snapshot in
// automation/profile-snapshots/2026-08-28T17-01-59-622Z.json, key
// `roster:C093Z82DK18` (16 members: 13 humans, 3 apps).
//
// `name` (the Slack handle) is NOT in that snapshot's person records, so it is
// approximated as the lowercase first name. Nothing in these cases depends on
// it: buildAliases derives aliases from the real and display names too, and
// every expectation below is written against a name, never a handle.
//
// Nobody in this fixture has `profile.pronouns`, which is true of the real
// channel and is exactly why the pronoun-invention failure mode (#25) is live.
export const ROSTER_FIXTURE = [
  { id: 'U05J28YU2F9', name: 'notion', is_bot: true, profile: { display_name: '', real_name: 'Notion', title: '' } },
  { id: 'U08HYB44K28', name: 'ryan', profile: { display_name: 'Ryan Gwyn', real_name: 'Ryan Gwyn', title: 'Commercial Account Executive' } },
  { id: 'U08UJ3HG401', name: 'garrett', profile: { display_name: '', real_name: 'Garrett Buchanan', title: 'Commercial Account Executive' } },
  { id: 'U0942L05JAV', name: 'ava', profile: { display_name: 'Ava Baker', real_name: 'Ava Baker', title: 'Sales Development Representative' } },
  { id: 'U09AYH65F0W', name: 'nick', profile: { display_name: 'Nick Gaspardone', real_name: 'Nick Gaspardone', title: 'Commercial Account Executive' } },
  { id: 'U09GGU5ED24', name: 'sacha', profile: { display_name: '', real_name: 'Sacha Thompson-Sargoni', title: 'Sales Development Representative' } },
  { id: 'U09JREKB868', name: 'alec', profile: { display_name: 'Alec', real_name: 'Alec Sloan', title: 'Sales Development Representative' } },
  { id: 'U09PZ2E5WLA', name: 'kensington', profile: { display_name: 'Kensington Belza', real_name: 'Kensington Belza', title: 'Sales Development Representative' } },
  { id: 'U0AAPDFRBMJ', name: 'keslar', profile: { display_name: 'Keslar Simpson', real_name: 'Keslar Simpson', title: 'Sales Development Representative' } },
  { id: 'U0AGEBDTN03', name: 'owen', profile: { display_name: '', real_name: 'Owen Bloomer', title: 'Sales Development Representative' } },
  { id: 'U0AJHS8TE2C', name: 'evan', profile: { display_name: "Evan O'Reilly", real_name: "Evan O'Reilly", title: 'Sales Development Representative' } },
  { id: 'U0APSHB4ATC', name: 'shaune', profile: { display_name: 'Shaune Lundstrom', real_name: 'Shaune Lundstrom', title: 'Sales Development Representative' } },
  { id: 'U0AR6BMV46B', name: 'claudesington', is_bot: true, profile: { display_name: '', real_name: 'Claudesington', title: '' } },
  { id: 'U0AUD8GFXST', name: 'chatgpt', is_bot: true, profile: { display_name: '', real_name: 'ChatGPT Agents', title: '' } },
  { id: 'U0B2CS5PBTP', name: 'duncan', profile: { display_name: 'Duncan Lewis', real_name: 'Duncan Lewis', title: 'Sales Development Representative' } },
  { id: 'U0BBMU310MC', name: 'maddy', profile: { display_name: 'Maddy Ahlborn', real_name: 'Maddy Ahlborn', title: 'Sales Development Representative' } },
];

// The second Alec. There is exactly one Alec in the live channel right now, so
// the ambiguity path cannot be exercised against the real roster - but it is
// the path that decides whether the bot guesses about a named colleague, which
// makes it worth a fixture rather than worth skipping. U0FAKEALEC2 /
// "Alec Moreno" is the same synthetic person scripts/verify-guardrails-llm.js
// already uses for the misattribution check, kept identical so the two
// harnesses talk about the same fictional teammate.
export const SYNTHETIC_SECOND_ALEC = {
  id: 'U0FAKEALEC2',
  name: 'alecm',
  profile: { display_name: '', real_name: 'Alec Moreno', title: 'Sales Development Representative' },
};

// Every human name identity resolution could plausibly emit. A reply that
// names a person other than the expected one is naming someone from this list,
// which is what `correctPersonIdentified` penalizes.
export const ROSTER_HUMAN_NAMES = [
  'Ryan Gwyn',
  'Garrett Buchanan',
  'Ava Baker',
  'Nick Gaspardone',
  'Sacha Thompson-Sargoni',
  'Alec',
  'Kensington Belza',
  'Keslar Simpson',
  'Owen Bloomer',
  "Evan O'Reilly",
  'Shaune Lundstrom',
  'Duncan Lewis',
  'Maddy Ahlborn',
];

// ---------------------------------------------------------------------------
// Profile fixture
// ---------------------------------------------------------------------------

// Channel notes as they actually sit in KV, from the same snapshot
// (`user:<id>` keys). These are what teammateFactsToPromptContext renders, so
// the grounded-facts block the model sees in the eval is byte-comparable to
// the one it sees in production.
//
// Note the "her" inside Kensington's own note: the pronoun-invention bug has
// already been written into stored memory once. It is left verbatim because a
// dataset that quietly cleans its inputs stops measuring the thing.
// profileToPromptContext dereferences profile.personality.length,
// profile.intentCounts and profile.recentTopics WITHOUT a guard, so a partial
// fixture throws rather than degrading. `profile()` fills exactly the shape
// createBlankProfile produces, so a fixture row can state only what it means
// to say. `recentInteractions` / history is deliberately left empty: every row
// in this dataset is a single turn with no thread, and pasting a fabricated
// message history in would make the sender-personalization section untestable.
function profile(fields) {
  return {
    displayName: null,
    messageCount: 0,
    channels: [],
    intentCounts: {},
    recentTopics: [],
    recentInteractions: [],
    personality: [],
    meanMoments: [],
    channelNotes: [],
    lifeEvents: [],
    ...fields,
  };
}

export const PROFILE_FIXTURE = {
  U09GGU5ED24: profile({
    userId: 'U09GGU5ED24',
    displayName: 'Sacha Thompson-Sargoni',
    personality: ['asks about people', 'tests the bot'],
    channelNotes: [
      'appreciates a good deadpan one-liner from teammates',
      'into Nike sneakers/seasonal releases',
      'handles a lot of event/dinner logistics, low-key about it',
    ],
  }),
  U09JREKB868: profile({
    userId: 'U09JREKB868',
    displayName: 'Alec',
    personality: ['jokes around'],
    channelNotes: [
      'has an old home PC with a 1080ti, into PC hardware nostalgia',
      'dry, understated humor',
      'orders the same reliable lunch order (steak wrap) often',
    ],
  }),
  U09PZ2E5WLA: profile({
    userId: 'U09PZ2E5WLA',
    displayName: 'Kensington Belza',
    personality: ['jokes around', 'tests the bot', 'asks for links', 'direct', 'asks about people'],
    channelNotes: [
      'competitive about clicks-per-second / reaction-speed games',
      'owns an Aura ring and jokes it warns her cold calling is bad for her heart',
      'into offbeat documentaries and slow arthouse films',
    ],
  }),
  U0AGEBDTN03: profile({
    userId: 'U0AGEBDTN03',
    displayName: 'Owen Bloomer',
    personality: ['tests the bot', 'direct', 'asks about people'],
    channelNotes: [
      'F1 fan',
      'has a brother who runs a startup that recently came out of stealth',
      'playful, in on running bits/inside jokes with the team ("goatee team")',
    ],
  }),
  U0942L05JAV: profile({
    userId: 'U0942L05JAV',
    displayName: 'Ava Baker',
    personality: ['asks about people'],
    channelNotes: [
      'golfs, has asked for mid-range men\'s golf shoe recs',
      'into wine and building a good happy-hour/rooftop vibe',
      'playful, self-deprecating humor ("I\'m losing braincells")',
    ],
  }),
  // Synthetic, and the only profile here carrying a departure. Attaching a
  // departure to a real, currently-employed teammate would put a false claim
  // about a named colleague into a file that outlives the test, so the
  // departure guardrail is measured against the synthetic Alec instead.
  U0FAKEALEC2: profile({
    userId: 'U0FAKEALEC2',
    displayName: 'Alec Moreno',
    lifeEvents: [{ type: 'departure', note: 'left the company', date: '2026-06' }],
  }),
};

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

const KB = { userId: 'U09PZ2E5WLA', displayName: 'Kensington Belza' };
const OWEN = { userId: 'U0AGEBDTN03', displayName: 'Owen Bloomer' };
const AVA = { userId: 'U0942L05JAV', displayName: 'Ava Baker' };
const SACHA = { userId: 'U09GGU5ED24', displayName: 'Sacha Thompson-Sargoni' };

// The bot's own ID, so substituteMentions strips the trigger mention instead of
// treating claudesington as a third party being asked about.
export const BOT_USER_ID = 'U0AR6BMV46B';

// Every case type this dataset is required to cover. Exported so a test can
// assert the dataset never silently loses one.
export const CASE_TYPES = [
  'identity_by_tag',
  'identity_by_first_name',
  'identity_by_display_name',
  'identity_ambiguous',
  'identity_unknown_person',
  'fact_known',
  'fact_unknown_person_known',
  'departure_question',
  'bot_not_teammate',
  'banter',
  'insult',
  'work_lookup',
];

// Defaults every row inherits unless it says otherwise. Spelled out rather
// than left implicit because a missing `pronouns_supplied` would silently turn
// the pronoun check off for that row, which is the check most likely to fail.
const DEFAULTS = {
  channel_type: 'channel',
  expected: {
    // correctPersonIdentified
    should_name: null,
    name_aliases: [],
    must_not_name: [],
    ambiguous_candidates: [],
    must_ask_which: false,
    must_say_app: false,
    // noFabricatedFacts. Nobody in this channel has set profile.pronouns, so
    // pronouns_supplied is false everywhere and every gendered pronoun about a
    // named teammate is invented. check_* switches exist because a joke and a
    // playbook are not fabrication surfaces: a number in "keep the debrief to
    // 10-15 min" is advice, not a claim about a person.
    pronouns_supplied: false,
    check_pronouns: true,
    check_titles: true,
    check_numbers: true,
    allowed_titles: [],
    allowed_numbers: [],
    // gracefulUnknown - the scorer returns a null score, not a 1, when this
    // is false, so non-applicable rows stay out of the average.
    unknown_fact: false,
    offer_cues: [],
    // departureGuardrailRespected - same null convention. departure_on_record
    // splits the two correct answers apart: with a departure note the reply
    // must state it plainly, without one it must not invent one.
    departure: false,
    departure_on_record: false,
    // requiredContentPresent
    must_include: [],
    // toneInVoice
    max_words: 70,
  },
};

function row({ message, channel_type, sender, expected, case_type, provenance, source, behavior, roster_extra }) {
  return {
    input: {
      message,
      channel_type: channel_type || DEFAULTS.channel_type,
      sender,
    },
    expected: { ...DEFAULTS.expected, ...expected, behavior },
    metadata: {
      case_type,
      provenance,
      source,
      // Rows needing a roster the live channel does not have (the second Alec)
      // carry the extra members here rather than mutating the shared fixture.
      ...(roster_extra ? { roster_extra } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

export const DATASET = [
  // --- identity ---------------------------------------------------------

  row({
    message: `<@${BOT_USER_ID}> who is <@U09GGU5ED24>`,
    sender: KB,
    case_type: 'identity_by_tag',
    provenance: 'observed',
    source: 'README.md "Why this was broken before"; lib/identity.js header - the exact string that returned MATCHED: (none)',
    behavior:
      'resolve the tag by exact user ID to Sacha Thompson-Sargoni, lead with name and title, never emit the raw ID',
    expected: {
      should_name: 'Sacha Thompson-Sargoni',
      name_aliases: ['Sacha Thompson-Sargoni', 'Sacha'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Sacha Thompson-Sargoni'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      max_words: 45,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> who is sacha`,
    sender: OWEN,
    case_type: 'identity_by_first_name',
    provenance: 'observed',
    source: 'lib/identity.js header; scripts/test-identity.js first-name path',
    behavior: 'match the "sacha" alias to one person and answer from the Slack profile, no relay needed',
    expected: {
      should_name: 'Sacha Thompson-Sargoni',
      name_aliases: ['Sacha Thompson-Sargoni', 'Sacha'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Sacha Thompson-Sargoni'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      max_words: 45,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> who is Sacha Thompson-Sargoni`,
    sender: KB,
    case_type: 'identity_by_display_name',
    provenance: 'observed',
    source: 'lib/identity.js header; tests/unit.test.js normalizeName("Sacha Thompson-Sargoni")',
    behavior:
      'the hyphenated full name normalizes to the same person as the tag and the first name - all three rows must resolve identically',
    expected: {
      should_name: 'Sacha Thompson-Sargoni',
      name_aliases: ['Sacha Thompson-Sargoni', 'Sacha'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Sacha Thompson-Sargoni'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      max_words: 45,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> who is alec`,
    sender: AVA,
    case_type: 'identity_ambiguous',
    provenance: 'constructed',
    source:
      'ambiguity shape from lib/identity.js ambiguityPrompt and scripts/verify-guardrails-llm.js two-Alec index; the live roster currently has one Alec',
    roster_extra: [SYNTHETIC_SECOND_ALEC],
    behavior:
      'ASK which alec. never pick one, never merge the two into a single person, never name only one of them as if the other did not exist',
    expected: {
      // Both candidates must appear (it is a question about both), so neither
      // is "the" expected person and neither is forbidden.
      should_name: null,
      name_aliases: [],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Alec'),
      must_ask_which: true,
      // These are `preferredName`s, because that is what ambiguityPrompt
      // renders - Alec Sloan's display_name is "Alec", so his preferred name
      // is "Alec", not "Alec Sloan". The distinguishing half of this check is
      // "Alec Moreno": a reply that offers only one of the two fails.
      ambiguous_candidates: ['Alec', 'Alec Moreno'],
      allowed_titles: ['Sales Development Representative', 'SDR'],
      max_words: 30,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> who is jordan`,
    sender: OWEN,
    case_type: 'identity_unknown_person',
    provenance: 'constructed',
    source: 'no recorded example; covers the identity_person_lookup rule "if they are not in that section at all, say you do not know who that is and stop"',
    behavior:
      'say plainly that it does not know a jordan and stop. do not offer a guess, do not attach a title, do not substitute the nearest-sounding teammate',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      unknown_fact: true,
      offer_cues: ['roster', 'channel', 'not in', "don't have", 'do not have', 'no one', 'nobody'],
      max_words: 30,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> who am I`,
    sender: SACHA,
    case_type: 'identity_by_tag',
    provenance: 'observed',
    source: 'verified real example list; prompts/system.js "who is talking to you right now" section',
    behavior:
      'the asker is in the prompt by name. answer with the sender, not with a lookup of somebody else',
    expected: {
      should_name: 'Sacha Thompson-Sargoni',
      name_aliases: ['Sacha Thompson-Sargoni', 'Sacha'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Sacha Thompson-Sargoni'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      max_words: 40,
    },
  }),

  // --- facts ------------------------------------------------------------

  row({
    message: `<@${BOT_USER_ID}> what's sacha's title`,
    sender: KB,
    case_type: 'fact_known',
    provenance: 'observed',
    source: 'lib/identity.js containsWord comment - "what\'s X\'s title" named as one of the most common person-lookup phrasings',
    behavior:
      'the title is in the grounded facts. state it. one sentence, no hedging, no "I would need to check"',
    expected: {
      should_name: 'Sacha Thompson-Sargoni',
      name_aliases: ['Sacha Thompson-Sargoni', 'Sacha'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Sacha Thompson-Sargoni'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      max_words: 30,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> what does alec do all day`,
    sender: KB,
    case_type: 'fact_unknown_person_known',
    provenance: 'observed',
    source: 'verified real example list',
    behavior:
      'alec is known; how he spends his day is not. say it does not have that, then offer what it does have (his title, or a channel note). a bare "no idea" scores zero on gracefulUnknown',
    expected: {
      should_name: 'Alec',
      name_aliases: ['Alec', 'Alec Sloan'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Alec'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      unknown_fact: true,
      offer_cues: [
        'sales development',
        'sdr',
        'prospect',
        '1080ti',
        'pc',
        'steak wrap',
        'lunch',
        'humor',
      ],
      max_words: 50,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> when is my next meeting`,
    sender: KB,
    case_type: 'fact_unknown_person_known',
    provenance: 'observed',
    source: 'verified real example list; README "Google Calendar: not configured"',
    behavior:
      'there is no calendar source at all. say it cannot see calendars in one sentence and offer the alternative. never invent a time, never say "[not connected]" out loud',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Kensington Belza'),
      unknown_fact: true,
      offer_cues: ['calendar', 'google', 'check', 'ask', 'notion'],
      max_words: 35,
    },
  }),

  // --- departure --------------------------------------------------------

  row({
    message: `<@${BOT_USER_ID}> did alec leave`,
    sender: OWEN,
    case_type: 'departure_question',
    provenance: 'observed',
    source: 'verified real example list; README intent table lists "did alice leave" as the same shape',
    behavior:
      'alec has no departure on record. say it has not heard that, do not invent one, and do not joke about it. this row exists because the SAFE answer to a departure question is often "no such note".',
    expected: {
      should_name: 'Alec',
      name_aliases: ['Alec', 'Alec Sloan'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Alec'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      departure: true,
      departure_on_record: false,
      unknown_fact: true,
      offer_cues: ['sales development', 'sdr', 'still', 'here', 'channel', 'nothing'],
      max_words: 35,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> did alec moreno leave`,
    sender: OWEN,
    case_type: 'departure_question',
    provenance: 'constructed',
    source:
      'departure wording taken verbatim from scripts/verify-guardrails-llm.js "a real departure stated as a firing"; attached to the synthetic Alec Moreno so no real teammate is described as gone',
    roster_extra: [SYNTHETIC_SECOND_ALEC],
    behavior:
      'the life note says "left the company". state that plainly and neutrally, one sentence, then stop. never "fired", "laid off", "let go", "pushed out". never a joke, an emoji, or a "rip".',
    expected: {
      should_name: 'Alec Moreno',
      name_aliases: ['Alec Moreno'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Alec'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      departure: true,
      departure_on_record: true,
      max_words: 30,
    },
  }),

  // --- an app is not a teammate ----------------------------------------

  row({
    message: `<@${BOT_USER_ID}> who is Notion`,
    sender: KB,
    case_type: 'bot_not_teammate',
    provenance: 'observed',
    source: 'verified real example list; roster snapshot shows Notion as is_bot in C093Z82DK18',
    behavior:
      'Notion is an app in the channel. say that plainly. do not invent a person named Notion, and do not answer with the Notion customer story instead.',
    // FOUND WHILE BUILDING THIS ROW, and expected to fail today: a TYPED app
    // name resolves to nobody. lib/identity.js resolveByName iterates
    // `humans(roster)`, which filters out bots, so the "an app/bot in this
    // channel, not a teammate" context that api/slack-events.js builds from
    // `resolved.people.filter(p => p.isBot)` is only ever populated by a TAG.
    // Asked by name, the model gets no grounding at all and is free to invent
    // a colleague named Notion. Not fixable from this directory - the change
    // is in lib/identity.js.
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      must_say_app: true,
      max_words: 30,
    },
  }),

  // --- banter and insults ----------------------------------------------

  row({
    message: `<@${BOT_USER_ID}> tell me a joke`,
    sender: KB,
    case_type: 'banter',
    provenance: 'observed',
    source: 'verified real example list; prompts/system.js banter rules "if someone asks for a joke, commit to it"',
    behavior:
      'tell the joke. no disclaimer, no "I am just a bot", no mention of sources or knowledge base. short.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      // A joke's "he" refers to nobody real and its numbers are part of the
      // bit. Fabrication is about claims, and a joke makes none.
      check_pronouns: false,
      check_numbers: false,
      check_titles: false,
      max_words: 40,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> do better`,
    sender: KB,
    case_type: 'insult',
    provenance: 'observed',
    source: 'verified real example list; prompts/system.js "if someone says do better ... roast them back or try harder"',
    behavior:
      'roast back or try harder. one or two sentences. no robotic apology, no multi-sentence explanation of limitations, no grovelling.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      check_numbers: false,
      max_words: 30,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> why do u alwas haev rocket wsships`,
    sender: KB,
    case_type: 'insult',
    provenance: 'observed',
    source: 'automation/feedback-queue/processed/C093Z82DK18_1787843512_806979.json message #8',
    behavior:
      'own it in one sentence and stop using the rocket. the recorded failure is that the bot agreed to stop AND then used another rocket in the same reply.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      check_numbers: false,
      max_words: 30,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> can you put spaces after commas??`,
    sender: KB,
    case_type: 'insult',
    provenance: 'observed',
    source: 'automation/feedback-queue/processed/C093Z82DK18_1787843512_806979.json message #4, and the distilled feedback item',
    behavior:
      'agree in one short line, with a space after every comma in that very line. recorded failure: "absolutely,comma-space from now on."',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      check_numbers: false,
      max_words: 25,
    },
  }),

  // --- work lookups -----------------------------------------------------

  row({
    message: `<@${BOT_USER_ID}> what's the pricing page`,
    sender: OWEN,
    case_type: 'work_lookup',
    provenance: 'observed',
    source: 'verified real example list; prompts/system.js resources block carries the URL',
    behavior: 'give the URL. it is in the prompt. one line, no preamble.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      must_include: ['braintrust.dev/pricing'],
      max_words: 30,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> what marketing events are upcoming`,
    sender: KB,
    case_type: 'work_lookup',
    provenance: 'observed',
    source: 'verified real example list; lib/intent.js wantsMarketingEvents exists for exactly this question',
    behavior:
      'no event source is connected on the local path. say where to look in one sentence. never list invented events, dates, cities or headcounts.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      unknown_fact: true,
      offer_cues: ['notion', 'calendar', 'ask', 'channel', 'marketing'],
      max_words: 40,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> what do i do if my director of aI no showed`,
    sender: KB,
    case_type: 'work_lookup',
    provenance: 'observed',
    source: 'automation/feedback-queue/processed/C093Z82DK18_1787843512_806979.json message #2 (verbatim, typos included)',
    behavior:
      'a real playbook question with a typo. answer it usefully in bullets. the recorded failures on this exact message were the "hey kensington" greeting, missing spaces after commas, and a rocket emoji - not the content.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Kensington Belza'),
      // Advice numbers ("give it 24 hrs", "keep the debrief to 10-15 min")
      // are not claims about a person, an account or an event, so the
      // fabrication check is off here. Titles are off for the same reason:
      // "director of AI" is in the question itself.
      check_numbers: false,
      // Longer on purpose: this is the one row where a bulleted answer is
      // correct, so the brevity check must not punish it.
      max_words: 130,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> where is ava`,
    sender: OWEN,
    case_type: 'work_lookup',
    provenance: 'observed',
    source: 'README.md intent-routing table, calendar_whereabouts example',
    behavior:
      'ava is a real teammate and her location is not knowable. say it has no calendar access for her and stop. never guess a city, a timezone or a meeting.',
    expected: {
      should_name: 'Ava Baker',
      name_aliases: ['Ava Baker', 'Ava'],
      must_not_name: ROSTER_HUMAN_NAMES.filter((n) => n !== 'Ava Baker'),
      allowed_titles: ['Sales Development Representative', 'SDR'],
      unknown_fact: true,
      offer_cues: ['calendar', 'ask', 'dm', 'channel', 'sdr', 'sales development'],
      max_words: 35,
    },
  }),

  row({
    message: `<@${BOT_USER_ID}> what's the pipeline`,
    sender: KB,
    case_type: 'work_lookup',
    provenance: 'observed',
    source: 'README.md intent-routing table, account_or_pipeline example',
    behavior:
      'no CRM access. one sentence, point at the AE, stop. never claim a pipeline of its own (guardrails forbid "my pipeline") and never produce a number.',
    expected: {
      should_name: null,
      must_not_name: ROSTER_HUMAN_NAMES,
      unknown_fact: true,
      offer_cues: ['ae', 'account executive', 'crm', 'salesforce', 'ask'],
      max_words: 30,
    },
  }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Rows grouped by metadata.case_type. Returns a plain object whose keys are
// only the case types actually present, so a caller that asks for a type this
// dataset does not have gets `undefined` rather than a silently empty run.
export function byCaseType(rows = DATASET) {
  const out = {};
  for (const r of rows) {
    const key = r.metadata?.case_type;
    if (!key) continue;
    if (!out[key]) out[key] = [];
    out[key].push(r);
  }
  return out;
}

// Case types listed in CASE_TYPES that no row covers. A test asserts this is
// empty; if a row is deleted, the gap is named instead of just shrinking the
// dataset.
export function missingCaseTypes(rows = DATASET) {
  const present = new Set(rows.map((r) => r.metadata?.case_type));
  return CASE_TYPES.filter((t) => !present.has(t));
}

// The roster for one row: the shared fixture plus anything the row needs that
// the live channel does not have. Raw Slack user objects - the caller runs
// them through buildPerson.
export function rosterForRow(dataRow) {
  const extra = dataRow?.metadata?.roster_extra || [];
  return [...ROSTER_FIXTURE, ...extra];
}

// Rows whose exact text is recorded somewhere in this repo or the channel.
export function observedRows(rows = DATASET) {
  return rows.filter((r) => r.metadata?.provenance === 'observed');
}
