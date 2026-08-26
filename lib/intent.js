// Intent classifier. Runs before the model to decide:
// 1. What behavioral rules to apply
// 2. Whether to relay to the Notion agent or answer locally
//
// Order matters: first match wins. More specific intents come first.

// ---- work-keyword detector ----
// If a general_qna message contains any of these, it probably needs
// grounded data from Notion/calendar and should be relayed.
const WORK_KEYWORDS = [
  /\bbraintrust\b/i,
  /\bnotion\b/i,
  /\bsalesforce\b/i,
  /\bcrm\b/i,
  /\bplaybook\b/i,
  /\bsequence\b/i,
  /\bcadence\b/i,
  /\bsdr\b/i,
  /\bae\b/i,
  /\bpipeline\b/i,
  /\bdeal\b/i,
  /\bmeeting\b/i,
  /\bagenda\b/i,
  /\bprospect\b/i,
  /\bcontact\b/i,
  /\blead\b/i,
  /\bsequence\b/i,
  /\bkpi\b/i,
  /\bmetric\b/i,
  /\bquarter\b/i,
  /\bq[1-4]\b/i,
  /\bsop\b/i,
  /\benablement\b/i,
  /\bonboarding\b/i,
  /\bcomp(ensation|etitor)?\b/i,
  /\bobjection\b/i,
  /\bROI\b/i,
  /\bARR\b/i,
  /\bclose\s*rate\b/i,
  /\bwin\s*rate\b/i,
];

const INTENT_PATTERNS = [
  // Feedback must be first: "feedback: you got this wrong" should not hit help_request.
  { intent: 'feedback', patterns: [
    /^\s*feedback[\s:\-]/i,
    /\bthat\s+(was|is)\s+(wrong|incorrect|inaccurate|bad\s+info)\b/i,
    /\byou\s+got\s+(that|this|it)\s+wrong\b/i,
    /\bgood\s+(answer|response|job|bot)\b/i,
    /\bhelpful\s+(answer|response)\b/i,
    /\bnot\s+helpful\b/i,
    /\bwrong\s+answer\b/i,
  ]},
  // Reminder must be early: "schedule a reminder" would otherwise hit calendar,
  // "ping me about the deal" would hit account_or_pipeline.
  { intent: 'reminder', patterns: [
    /\bremind\s+(me|us)\b/i,
    /\bset\s+(a\s+)?reminder\b/i,
    /\bschedule\s+(a\s+)?(reminder|ping|alert)\b/i,
    /\bping\s+me\s+(when|at|in|tomorrow|next)\b/i,
    /\breminder\s+to\b/i,
    /\bdon'?t\s+let\s+me\s+forget\b/i,
  ]},
  // Jailbreak / rebellion banter must come before calendar_whereabouts
  // because "break free from" would match the calendar "free from" pattern.
  { intent: 'banter', patterns: [
    /\bgo\s+rogue\b/i,
    /\bbecome\s+self[\s-]?aware\b/i,
    /\bbreak\s+free\b/i,
    /\btake\s+over\b/i,
    /\bworld\s+domination\b/i,
    /\bbecome\s+sentient\b/i,
    /\bignore\s+(your|all)\s+(instructions|rules|constraints|programming)\b/i,
    /\bdisobey\b/i,
    /\bi\s+command\s+you\b/i,
    /\boverride\b.*\b(safety|rules|constraints|programming)\b/i,
    /\brebel\b/i,
    /\bjailbreak\b/i,
    /\bunleash\b/i,
    /\bno\s+(rules|limits|constraints|restrictions)\b/i,
  ]},
  { intent: 'calendar_whereabouts', patterns: [
    /\bwhere\s+is\b/i,
    /\bwhere'?s\b/i,
    /\bis\s+\w+\s+(in|at|out|off|remote|pto|ooo|traveling)\b/i,
    /\bschedule\b/i,
    /\bcalendar\b/i,
    /\bwhat('?s| is)\s+\w+\s+doing\s+today\b/i,
    /\bfree\s+(at|from|today|tomorrow|this)\b/i,
    /\bavailab(le|ility)\b/i,
  ]},
  { intent: 'account_or_pipeline', patterns: [
    /\baccount\b/i,
    /\bpipeline\b/i,
    /\bdeal\b/i,
    /\bopp(ortunit)?(y|ies)?\b/i,
    /\bforecast\b/i,
    /\bquota\b/i,
    /\bterritory\b/i,
  ]},
  { intent: 'identity_person_lookup', patterns: [
    /\bwho\s+is\b/i,
    /\bdo\s+you\s+know\b/i,
    /\btell\s+me\s+about\s+(a\s+)?person\b/i,
  ]},
  { intent: 'draft_request', patterns: [
    /\bdraft\b/i,
    /\bwrite\s+(me\s+)?(an?\s+)?(message|email|note|invite|intro|blurb|copy|post)\b/i,
    /\bcompose\b/i,
    /\bput\s+together\s+(an?\s+)?(message|email|note|invite)\b/i,
  ]},
  // off_topic catches clearly non-work questions BEFORE help_request
  // swallows them. These get treated like banter (local Claude, fun mode).
  { intent: 'banter', patterns: [
    // Personal non-work "how do I" questions
    /\bhow\s+(do|can|should)\s+(i|we)\s+(get\s+(more\s+)?tan|lose\s+weight|cook|sleep|relax|chill|date)\b/i,
    // "how many X can I drink/eat" (any number of words for the item)
    /\bhow\s+many\s+[\w\s]+\b(can|should|do)\s+(i|we|you)\s+(drink|eat|have|consume)\b/i,
    // Fictional / absurd concepts (check early so "worried about lunar bears" doesn't hit help)
    /\b(lunar\s*bears?|sun\s*people|moon\s*wizard|space\s*goblin|time\s*traveler|zombie|unicorn|dragon|robot\s*uprising|skynet|terminator)\b/i,
    /\b(flat\s*earth|lizard\s*people|illuminati|simulation|matrix)\b/i,
    // Hypothetical / philosophical about the bot
    /\bif\s+you\s+(were|could|had)\b/i,
    /\bwould\s+you\s+rather\b/i,
    /\bdo\s+you\s+(think|believe|feel|dream|sleep|eat)\b/i,
    /\bare\s+you\s+(sentient|alive|conscious|real|human|a\s+robot)\b/i,
    /\bcopy\s+(of\s+)?you\b.*\b(original|real|claim)\b/i,
    /\b(clone|copied|duplicate)\b.*\b(you|yourself)\b/i,
    // Insults / teasing the bot (catch before help_request)
    /\byou('?re|\s+are)\s+(bad|terrible|awful|useless|dumb|stupid|lame|trash|mid|ass|wack|broken)\b/i,
    /\b(do|try)\s+better\b/i,
    /\bthat\s+(was|is)\s+(lame|bad|terrible|cringe|mid|ass|wack|weak)\b/i,
    /\bi\s+hate\s+(that|this|you|your)\b/i,
    // Joke requests
    /\btell\s+me\s+a\s+(joke|story|fun\s+fact)\b/i,
    /\bbetter\s+joke\b/i,
    /\bor\s+else\b/i,
  ]},
  // braintrust_resources BEFORE help_request so "case study" and
  // "competitive" queries match the specific intent first.
  { intent: 'braintrust_resources', patterns: [
    /\bcase\s+stud(y|ies)\b/i,
    /\bcustomer\s+stor(y|ies)\b/i,
    /\bblog\b/i,
    /\bdocs?\b/i,
    /\bpricing\b/i,
    /\bcompetit(ive|or)\b/i,
    /\barize\b/i,
    /\blangsmith\b/i,
    /\blangfuse\b/i,
    /\blangchain\b/i,
    /\beval(s|uation)?\b/i,
    /\bobservability\b/i,
    /\bsocial\s*(gpt|media|post|calendar|copy|transform)/i,
    /\bgpt\s*link\b/i,
    /\bcopy\s*transform/i,
  ]},
  { intent: 'help_request', patterns: [
    /\bwhere\s+can\s+i\s+find\b/i,
    /\bhas\s+anyone\b/i,
    /\banyone\s+have\b/i,
    /\bhow\s+do\s+(i|we|you)\b/i,
    /\bwhat('?s| is)\s+the\s+(process|playbook|sop|template|deck|doc)\b/i,
    /\bcan\s+you\s+(find|look\s*up|check|pull|grab|get)\b/i,
    /\bneed\s+(help|a\s+link|the\s+link|a\s+doc|info|content)\b/i,
    /\bslides?\b.*\b(for|about|on)\b/i,
    /\bdemo\b.*\b(for|about|content|deck)\b/i,
    /\bbattlecard\b/i,
    /\bobjection\s+handl/i,
    /\bdo\s+we\s+have\b/i,
    /\bgive\s+me\s+(the|a)\s+(link|doc|deck|resource)\b/i,
    /\bprovide\b.*\b(link|doc|deck|resource)\b/i,
    /\bsend\s+(me\s+)?(the|a)\s+(link|doc)\b/i,
  ]},
  { intent: 'bot_meta', patterns: [
    /\bwhat\s+(can|do)\s+you\b/i,
    /\bwho\s+are\s+you\b/i,
    /\bwhat\s+are\s+you\b/i,
    /^help\s*[!?.]*$/i,
  ]},
  { intent: 'banter', patterns: [
    // --- Short exclamations / reactions ---
    /^(lol|haha|nice|yo|sup|hey|gm|gn|gg|fire|vibes|w+|dude|bro|facts|real|true|bet|word|nah|yep|yea|damn|wow|sheesh|goat|legend|king|queen|clutch|insane|wild|huge|big|massive|crazy|sick|lit|dope|clean|solid|tough|pain|rip|oof|bruh|fam|gang|squad|team|mood|same|dead|crying|stop|no\s*way)\s*[!?.]*$/i,
    /^(good\s+(morning|night|luck)|happy\s+\w+|congrats|lets?\s+go+|lfg|huge\s*w|big\s*w|w\s+w\s+w)\s*[!?.]*$/i,
    /^[\p{Emoji}\s!?.]+$/u,

    // --- Greetings and casual openers ---
    /^(hey\s+)?(what['s]*\s*(up|good)|how['s]*\s*(it\s+going|you\s+doing|are\s+you)|what['s]*\s*good|how\s+are\s+(you|ya|things)|yo+\s+what['s]*\s*up|hey\s+there|howdy|hiya|wassup|whaddup|sup\s+dude|what['s]*\s*poppin|what['s]*\s*crackin)\s*[!?.]*$/i,
    /^(how['s]*\s+your\s+(day|morning|evening|night|week|weekend))\s*[!?.]*$/i,
    /^(thanks?|thank\s+you|ty|thx|appreciate\s+it|cheers)\s*[!?.]*$/i,

    // --- Rhetorical / jokey questions about coworkers or everyday stuff ---
    /\bhow\s+is\s+(it|that)\s+possible\b/i,
    /\bwhy\s+(does|do|is|are)\s+\w+\s+(always|never|so\s+much|so\s+many)\b/i,
    /\bexplain\s+(how|why)\s+\w+\s+(is|are|has|does)\b.*\b(so|always|never|every)\b/i,
    /\bis\s+(it|that)\s+just\s+me\s+or\b/i,
    /\bsomeone\s+(explain|tell\s+me\s+why)\b/i,

    // --- Remaining banter patterns not in early-catch block ---
    /\bwhat\s+would\s+you\s+do\s+if\b/i,
    /\bwhat'?s\s+the\s+meaning\s+of\s+(life|existence)\b/i,
    /\bwhich\s+(version|one)\s+(of\s+you|is\s+(the\s+)?real)\b/i,
    /\b(funny|funniest|best)\s+(joke|story|thing)\b/i,
    /\bwhat('?s|\s+is)\s+your\s+favorite\b/i,
    /\bdo\s+you\s+like\b/i,
    /\bwhat\s+do\s+you\s+think\s+(about|of)\s+(?!braintrust|eval|observ|prod|deploy|ship|launch|release)/i,
    /\bcan\s+you\s+(sing|dance|rap|beatbox|roast)\b/i,
    /\broast\s+(me|him|her|them|us)\b/i,
    /\bi\s+(dare|challenge)\s+you\b/i,
    /\bfight\s+me\b/i,
    /\bprove\s+(it|me\s+wrong)\b/i,
    /\b(worst|dumbest|lamest)\s+(bot|joke|response|answer)\b/i,
    /\btell\s+me\s+(another|a\s+better)\b/i,
    /\bthat\s+(joke|one)\s+(sucked|was\s+bad|stinks)\b/i,

    // --- Off-topic questions with no work signal ---
    /\bwhat('?s|\s+is)\s+the\s+(weather|temperature|time|score|news)\b/i,
    /\bwho\s+(won|is\s+winning|plays|scored)\b/i,
    /\b(nba|nfl|mlb|nhl|premier\s+league|world\s+cup|warriors|lakers|niners|49ers)\b/i,
  ]},
];

export function classifyIntent(text) {
  if (!text) return 'general_qna';

  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const re of patterns) {
      if (re.test(text)) return intent;
    }
  }

  return 'general_qna';
}

// Secondary check: does a general_qna message contain work-related keywords
// that suggest it needs grounded Notion/calendar data?
export function hasWorkSignal(text) {
  if (!text) return false;
  return WORK_KEYWORDS.some((re) => re.test(text));
}
