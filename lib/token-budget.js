// Prompt token budgeting and truncation.
//
// WHY THIS EXISTS
// prompts/system.js concatenates its context blocks unconditionally: sender
// identity, the sender's profile, their last 8 messages, facts about every
// teammate named in the message, thread context (up to 4000 chars from
// lib/thread-context.js), calendar, capability summary, intent rules, and
// ~4KB of fixed persona/customer-story text. Every one of those has its own
// local cap and none of them know about each other, so the only thing
// bounding the total is the sum of the individual caps - and two of them are
// not capped at all: the number of teammates named in one message, and the
// number of blocks that happen to be present at once.
//
// That matters here specifically because Groq's on-demand tier caps
// TOKENS PER MINUTE at 8000 and a single reply already costs ~2500. A prompt
// that quietly doubles turns "three replies a minute for the whole workspace"
// into one, and the visible symptom is not a truncated prompt - it is
// lib/claude.js exhausting its 20s retry budget and the caller degrading to
// "hit a snag on my end".
//
// DESIGN
// Pure functions, no I/O, no env reads, no clock. The caller hands over named
// sections with priorities and a budget and gets back a fitted set plus an
// explicit account of what was kept, truncated, and dropped. Nothing is
// dropped silently: every decision comes back in the result so it can be
// logged and scored.
//
// NOT WIRED IN. Wiring this into prompts/system.js is a separate change; see
// docs/FAILURE-MODES.md.

// Token estimation is deliberately a heuristic. Groq exposes real counts only
// AFTER the call (response.usage.prompt_tokens), which is too late to budget
// against, and shipping a tokenizer for one model family is not worth the
// dependency. Four characters per token is the standard rough figure for
// English prose and slightly UNDER-counts code and URLs, so treat the budget
// as approximate and leave headroom via `reserve`.
const CHARS_PER_TOKEN = 4;

// The marker left in place of removed text. Visible on purpose: a model that
// can see it was truncated behaves better than one silently handed a fragment.
export const TRUNCATION_MARKER = '\n[truncated]\n';

// A sane total for THIS system: ~8000 tokens/minute shared across the whole
// workspace, ~2500 tokens per reply end to end. Keeping the prompt near 2200
// leaves room for the completion (max_tokens is 150 for banter, 400
// otherwise in lib/claude.js) and for two other people talking to the bot in
// the same minute.
export const RECOMMENDED_PROMPT_BUDGET_TOKENS = 2200;

// THE TRUNCATION PRIORITY ORDER.
//
// Higher number = more important = surrendered last. The order encodes what
// this bot gets punished for getting wrong, in the order the punishment
// hurts:
//
//  persona          - required. Without it the bot is not claudesington, it
//                     is a generic assistant with a Slack token.
//  mentioned_facts  - grounded roster facts about real, named people. This is
//                     the whole point of Phase 1; losing it is how the model
//                     starts inventing titles and pronouns for coworkers.
//  sender_identity  - who is talking. Cheap (one line) and everything
//                     downstream reads wrong without it.
//  capabilities     - the self-limiting block ("calendar: NO. do not guess
//                     whereabouts"). Drop this and the bot confidently
//                     answers questions it has no data for.
//  intent_rules     - per-intent behavioral rules. Cheap, high leverage.
//  calendar_context - fetched only for calendar_whereabouts, so when present
//                     it IS the answer.
//  notion_context   - not assembled on the local path any more (the direct
//                     Notion API path was removed; the relay is the only
//                     Notion path). Kept in the table so the priority is
//                     already decided if a Notion block returns.
//  marketing_events - same: not currently assembled.
//  thread_context   - useful, but the current message usually stands alone,
//                     and this is the single largest variable block. Keeps
//                     its END (most recent turns).
//  user_profile     - personalization. Nice, never load-bearing.
//  user_history     - the sender's last messages. Keeps its END.
//  channel_notes    - banter colour. First thing out the door.
export const SECTION_PRIORITY = Object.freeze({
  persona: 1000,
  mentioned_facts: 100,
  sender_identity: 95,
  capabilities: 90,
  intent_rules: 85,
  calendar_context: 70,
  notion_context: 60,
  marketing_events: 50,
  thread_context: 40,
  user_profile: 30,
  user_history: 20,
  channel_notes: 10,
});

// Section names in the order they are surrendered, lowest priority first.
// Exported so the order can be asserted in a test rather than reviewed by eye.
export const TRUNCATION_ORDER = Object.freeze(
  Object.entries(SECTION_PRIORITY)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name),
);

// Sections that keep their tail (most recent content) rather than their head.
const KEEP_END_BY_DEFAULT = new Set(['thread_context', 'user_history']);

export function estimateTokens(text) {
  if (text === null || text === undefined) return 0;
  const s = typeof text === 'string' ? text : String(text);
  if (!s.length) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function tokensToChars(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

// Priority for a known section name. Unknown names get `fallback` so a new
// context block added later degrades to "least important" instead of throwing
// or accidentally outranking grounded facts.
export function priorityOf(name, fallback = 0) {
  return Object.prototype.hasOwnProperty.call(SECTION_PRIORITY, name)
    ? SECTION_PRIORITY[name]
    : fallback;
}

// Cut `text` down to at most `maxTokens`, keeping either its start or its end,
// on a whitespace boundary where one is close enough to be worth using.
//
// Returns { text, truncated, tokens, originalTokens }. The marker's own cost
// is charged against maxTokens, so the result never exceeds the ask.
export function truncateToTokens(text, maxTokens, options = {}) {
  const { keep = 'start', marker = TRUNCATION_MARKER } = options;
  const source = typeof text === 'string' ? text : text == null ? '' : String(text);
  const originalTokens = estimateTokens(source);

  if (originalTokens <= maxTokens) {
    return { text: source, truncated: false, tokens: originalTokens, originalTokens };
  }

  const markerTokens = estimateTokens(marker);
  const bodyChars = tokensToChars(maxTokens - markerTokens);

  // Not even room for the marker plus a scrap of text: emit nothing. Better an
  // absent section (which the caller sees in `dropped`) than a lone marker
  // that costs tokens and carries no information.
  if (bodyChars <= 0) {
    return { text: '', truncated: true, tokens: 0, originalTokens };
  }

  let body;
  if (keep === 'end') {
    body = source.slice(source.length - bodyChars);
    // Advance to the next whitespace so we don't start mid-word, but only if
    // that boundary is nearby - otherwise we'd throw away most of the budget.
    const cut = firstBoundary(body);
    if (cut > 0 && cut < bodyChars * 0.2) body = body.slice(cut);
    body = marker + body.replace(/^\s+/, '');
  } else {
    body = source.slice(0, bodyChars);
    const cut = lastBoundary(body);
    if (cut > bodyChars * 0.8) body = body.slice(0, cut);
    body = body.replace(/\s+$/, '') + marker;
  }

  return { text: body, truncated: true, tokens: estimateTokens(body), originalTokens };
}

function lastBoundary(s) {
  const nl = s.lastIndexOf('\n');
  if (nl > -1) return nl;
  return s.lastIndexOf(' ');
}

function firstBoundary(s) {
  const nl = s.indexOf('\n');
  if (nl > -1) return nl + 1;
  const sp = s.indexOf(' ');
  return sp > -1 ? sp + 1 : 0;
}

// Fit a set of named sections into a token budget.
//
// sections: [{
//   name,                  // required, string. Also selects the default priority.
//   text,                  // the content. Empty/whitespace sections are reported
//                          //   as included:false, reason:'empty' and cost nothing.
//   title,                 // optional heading used by renderSections()
//   priority,              // optional override; defaults to priorityOf(name)
//   required,              // never dropped. Truncated as a last resort instead.
//   keep,                  // 'start' (default) | 'end'
//   minTokens,             // don't bother including a truncated remnant smaller
//                          //   than this; drop the section instead
//   truncatable,           // default true. false = all-or-nothing.
// }]
//
// options: { budget, reserve = 0, estimator = estimateTokens, marker }
//
// `reserve` is subtracted from the budget before fitting. Use it for the parts
// of the request the caller controls but this function never sees: the user
// turn, the completion allowance, chat-template overhead.
//
// Returns {
//   budget, reserve, effectiveBudget, totalTokens, overBudget,
//   sections: [ per-section result, in INPUT order ],
//   kept: [names], truncated: [names], dropped: [names],
// }
export function fitSections(sections, options = {}) {
  const {
    budget,
    reserve = 0,
    estimator = estimateTokens,
    marker = TRUNCATION_MARKER,
  } = options;

  if (!Number.isFinite(budget) || budget < 0) {
    throw new TypeError('fitSections: budget must be a non-negative finite number');
  }
  if (!Array.isArray(sections)) {
    throw new TypeError('fitSections: sections must be an array');
  }

  const effectiveBudget = Math.max(0, budget - Math.max(0, reserve));

  const normalized = sections.map((raw, index) => {
    if (!raw || typeof raw.name !== 'string' || !raw.name) {
      throw new TypeError('fitSections: every section needs a non-empty name');
    }
    const text = typeof raw.text === 'string' ? raw.text : raw.text == null ? '' : String(raw.text);
    return {
      index,
      name: raw.name,
      title: raw.title ?? raw.name,
      priority: Number.isFinite(raw.priority) ? raw.priority : priorityOf(raw.name),
      required: Boolean(raw.required),
      keep: raw.keep === 'end' || KEEP_END_BY_DEFAULT.has(raw.name) ? 'end' : 'start',
      minTokens: Number.isFinite(raw.minTokens) ? Math.max(0, raw.minTokens) : 0,
      truncatable: raw.truncatable === undefined ? true : Boolean(raw.truncatable),
      source: text,
      originalTokens: estimator(text),
    };
  });

  // Required first, then by priority (high to low), then by input order so the
  // outcome is deterministic for equal priorities.
  const order = [...normalized].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.index - b.index;
  });

  const results = new Map();
  let spent = 0;
  let overBudget = false;

  for (const section of order) {
    const base = {
      name: section.name,
      title: section.title,
      priority: section.priority,
      required: section.required,
      keep: section.keep,
      originalTokens: section.originalTokens,
    };

    if (!section.source.trim()) {
      results.set(section.index, {
        ...base, text: '', tokens: 0, included: false, truncated: false, reason: 'empty',
      });
      continue;
    }

    const remaining = effectiveBudget - spent;

    if (section.originalTokens <= remaining) {
      spent += section.originalTokens;
      results.set(section.index, {
        ...base, text: section.source, tokens: section.originalTokens,
        included: true, truncated: false, reason: 'fit',
      });
      continue;
    }

    if (!section.truncatable) {
      if (section.required) {
        // All-or-nothing AND required: it goes in whole and the budget loses.
        // Reporting overBudget is the honest answer; silently dropping the
        // persona or the grounded facts is not.
        spent += section.originalTokens;
        overBudget = true;
        results.set(section.index, {
          ...base, text: section.source, tokens: section.originalTokens,
          included: true, truncated: false, reason: 'required_over_budget',
        });
      } else {
        results.set(section.index, {
          ...base, text: '', tokens: 0, included: false, truncated: false,
          reason: 'no_room',
        });
      }
      continue;
    }

    // Truncatable. A remnant has to clear minTokens to be worth its own cost.
    const allowance = section.required
      ? Math.max(remaining, section.minTokens)
      : remaining;

    if (allowance <= 0 || allowance < section.minTokens) {
      if (section.required) {
        const cut = truncateToTokens(section.source, Math.max(section.minTokens, 1), {
          keep: section.keep, marker,
        });
        spent += cut.tokens;
        if (spent > effectiveBudget) overBudget = true;
        results.set(section.index, {
          ...base, text: cut.text, tokens: cut.tokens,
          included: Boolean(cut.text), truncated: true, reason: 'required_min',
        });
      } else {
        results.set(section.index, {
          ...base, text: '', tokens: 0, included: false, truncated: false,
          reason: 'no_room',
        });
      }
      continue;
    }

    const cut = truncateToTokens(section.source, allowance, { keep: section.keep, marker });
    if (!cut.text) {
      results.set(section.index, {
        ...base, text: '', tokens: 0, included: false, truncated: true,
        reason: 'no_room',
      });
      continue;
    }
    spent += cut.tokens;
    if (spent > effectiveBudget) overBudget = true;
    results.set(section.index, {
      ...base, text: cut.text, tokens: cut.tokens,
      included: true, truncated: true, reason: 'truncated',
    });
  }

  const inInputOrder = normalized.map((s) => results.get(s.index));

  const kept = [];
  const truncated = [];
  const dropped = [];
  for (const section of order) {
    const r = results.get(section.index);
    if (r.included) kept.push(r.name);
    else if (r.reason !== 'empty') dropped.push(r.name);
    if (r.truncated && r.included) truncated.push(r.name);
  }

  return {
    budget,
    reserve: Math.max(0, reserve),
    effectiveBudget,
    totalTokens: spent,
    overBudget,
    sections: inInputOrder,
    kept,
    truncated,
    dropped,
  };
}

// Join the sections that survived into a prompt fragment, in input order.
// Headings use each section's `title`. Sections that were dropped or were
// empty contribute nothing at all - not an empty heading.
export function renderSections(fitted, options = {}) {
  const { headingPrefix = '## ', separator = '\n\n' } = options;
  if (!fitted?.sections) return '';
  return fitted.sections
    .filter((s) => s.included && s.text)
    .map((s) => (s.title ? `${headingPrefix}${s.title}\n${s.text}` : s.text))
    .join(separator);
}

// One-line, greppable summary for the logs. The point of the whole module is
// that a dropped section is observable, so give it a stable prefix to alert on.
//
//   prompt-budget: 2180/2200 tokens kept=[persona,...] truncated=[thread_context] dropped=[user_history]
export function budgetLogLine(fitted) {
  if (!fitted) return 'prompt-budget: no result';
  const parts = [
    `prompt-budget: ${fitted.totalTokens}/${fitted.effectiveBudget} tokens`,
    `kept=[${fitted.kept.join(',')}]`,
    `truncated=[${fitted.truncated.join(',')}]`,
    `dropped=[${fitted.dropped.join(',')}]`,
  ];
  if (fitted.overBudget) parts.push('OVER_BUDGET');
  return parts.join(' ');
}
