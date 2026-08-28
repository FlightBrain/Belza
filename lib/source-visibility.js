// Source-visibility gate for anything the relay brings back.
//
// WHY THIS EXISTS
// The relay asks a Notion AI agent a question and posts its answer into a
// group Slack channel. That agent authenticates as a person, so it can see
// things the people reading the answer cannot: private Notion pages, Slack
// channels the asker isn't in, 1:1 notes, calendar detail. The relay is a
// privilege boundary, and until now nothing checked what crossed it.
//
// Observed in real traffic before this existed:
//  - Every reply carried an internal Notion agent activity URL. lib/guardrails
//    only stripped "www.notion.so/agent/", but the agent emits
//    "app.notion.com/agent/", so it survived - and guardrails' "label bare
//    bracketed links" rule then helpfully rendered it as a clickable "link".
//  - One reply echoed the agent's own system prompt into the channel:
//    "You are Kensington Belza, a Strategic SDR at Braintrust (<email>)".
//  - One reply cited a Slack archive permalink to a channel other than the
//    one being answered in.
//
// This module is deliberately a DENY list applied to output, not a filter on
// what the agent may read - we don't control the agent's grants. It fails
// closed on the specific shapes that can only come from a privileged source.

// Notion deep links. Useless to anyone without access, and the page id itself
// leaks the existence and identity of a private page.
const NOTION_LINK = /<?\bhttps?:\/\/(?:app\.notion\.com|www\.notion\.so|notion\.so)\/[^\s>|]*(?:\|[^>]*)?>?/gi;

// Slack permalinks. Allowed only when they point at the channel being
// answered in; otherwise they advertise a conversation the reader may not be
// in.
const SLACK_ARCHIVE_LINK = /<?\bhttps?:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)(?:\/p\d+)?[^\s>|]*(?:\|[^>]*)?>?/gi;

// Email addresses, including the Slack <mailto:...|...> form.
const MAILTO_LINK = /<mailto:[^>|]+(?:\|[^>]*)?>/gi;
const BARE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/gi;

// System-prompt echo. An agent restating its own persona is never an answer to
// a user's question, and it carries whatever identity was baked into it.
const PROMPT_ECHO = [
  /^\s*you are\s+[^.\n]{2,80}[.,]/i,
  /^\s*(your|the)\s+(role|persona|instructions?|task)\s+(is|are)\b/i,
  /\bas an? (ai|assistant|agent),? (you|i)\b/i,
];

// Phrases that mean the agent is describing a source rather than answering,
// and that name a source the channel cannot see.
const PRIVATE_SOURCE_MENTION = [
  /\b(1:1|one[- ]on[- ]one)\s+(notes?|doc|page|meeting)\b/i,
  /\bprivate\s+(page|channel|note|doc|calendar)\b/i,
  /\bdirect\s+message(s)?\b/i,
  /\byour\s+dms?\b/i,
  /\bperformance\s+(review|plan|improvement)\b/i,
  /\bcompensation\s+(doc|sheet|band|plan)\b/i,
  /\bsalary\b/i,
];

// Redact everything that must not be spoken in `channelId`.
//
// Returns { text, redactions, blocked }.
//  - redactions: labels for what was removed, for logging and Braintrust
//    metadata. A silent redaction is not much better than a leak.
//  - blocked: true when the answer is unsafe as a whole rather than
//    salvageable by removing a link. The caller must not post it.
export function redactForChannel(text, { channelId } = {}) {
  if (!text) return { text: text || '', redactions: [], blocked: false };

  const redactions = [];
  let out = text;

  if (NOTION_LINK.test(out)) {
    redactions.push('notion_link');
    out = out.replace(NOTION_LINK, ' ');
  }

  out = out.replace(SLACK_ARCHIVE_LINK, (full, chan) => {
    if (channelId && chan === channelId) return full; // same channel, fine
    redactions.push('slack_link_other_channel');
    return ' ';
  });

  if (MAILTO_LINK.test(out)) {
    redactions.push('email');
    out = out.replace(MAILTO_LINK, ' ');
  }
  if (BARE_EMAIL.test(out)) {
    if (!redactions.includes('email')) redactions.push('email');
    out = out.replace(BARE_EMAIL, ' ');
  }

  // Drop whole lines that are a prompt echo rather than an answer.
  const keptLines = [];
  for (const line of out.split('\n')) {
    if (PROMPT_ECHO.some((re) => re.test(line))) {
      redactions.push('prompt_echo');
      continue;
    }
    keptLines.push(line);
  }
  out = keptLines.join('\n');

  // Tidy the holes the redactions left.
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Whole-answer refusal: it is discussing a source the channel cannot see.
  const privateSource = PRIVATE_SOURCE_MENTION.find((re) => re.test(out));
  if (privateSource) {
    redactions.push('private_source_mention');
    return {
      text: "i found something but it's from somewhere i shouldn't repeat in here. ask me in a dm.",
      redactions,
      blocked: true,
    };
  }

  // If redaction ate the answer, don't post a fragment.
  if (!out || out.length < 8) {
    redactions.push('empty_after_redaction');
    return {
      text: "i got an answer back but it was all internal links, nothing i can usefully repeat here.",
      redactions,
      blocked: true,
    };
  }

  return { text: out, redactions, blocked: false };
}

// True when this channel is a place where privileged content must never be
// spoken. Everything except a DM with the person who asked, effectively - a
// group channel has an audience the agent's grants know nothing about.
export function isPublicSurface(event) {
  return event?.channel_type !== 'im';
}
