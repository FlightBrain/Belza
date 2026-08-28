// Post-processing guardrails applied to every model response before posting.

const FORBIDDEN_PHRASES = [
  /\blol nah\b/i,
  /\bidk man\b/i,
  /\bthat'?s not my (world|problem|thing|area)\b/i,
  /\bi'?m not a messenger service\b/i,
  /\bi'?m an sdr\b/i,
  /\bi own \d+ (named )?accounts\b/i,
  /\b170 named accounts\b/i,
  /\bmy quota\b/i,
  /\bmy pipeline\b/i,
  /\bmy territory\b/i,
  /\bmy deals?\b/i,
  /\bask nate\b/i,
  /\bcooked\b/i,
  /\bykiyk\b/i,
  /\bnot my (job|problem|circus)\b/i,
  /\babove my pay\s*grade\b/i,
  /\bthat'?s on you\b/i,
  /\bgood luck with that\b/i,
];

// Canned-sounding deflection patterns the model sometimes generates.
// These feel robotic and unhelpful. If the WHOLE response is basically
// one of these, replace it. If it's embedded in a longer response, strip it.
const CANNED_DEFLECTIONS = [
  /i'?m not confident from the sources i can access/i,
  /i do not have any update from the sources i can access/i,
  /i don'?t have (enough )?(relevant |internal )?(information|guidance|context|data|update) (to cite|from the sources)/i,
  /i searched (our|the) (notion|slack).{0,30}didn'?t find/i,
  /my search only turned up unrelated/i,
  /i'?m not able to (help|assist) with that/i,
  /that'?s (outside|beyond) (my|the) (scope|knowledge|context)/i,
  /i do not have .{0,30}(from the sources|to cite|in my context)/i,
  /i also cannot schedule a calendar reminder because i do not have/i,
];

const SAFE_FALLBACK =
  "i'm not sure on that one. happy to help if you can give me more context.";

function linkLabel(url) {
  return /calendar\.notion\.so|\/event\//i.test(url) ? 'calendar link' : 'link';
}

// Returns the reply unchanged if clean, or a safe fallback if it trips a rule.
export function applyGuardrails(reply) {
  if (!reply) return reply;

  // Check forbidden phrases
  for (const pattern of FORBIDDEN_PHRASES) {
    if (pattern.test(reply)) {
      console.warn(`guardrail tripped: ${pattern}`);
      if (reply.length < 40) return SAFE_FALLBACK;
      reply = reply.replace(pattern, '').replace(/\s+/g, ' ').trim();
    }
  }

  // Strip canned deflections. If the entire response IS a deflection, replace.
  for (const pattern of CANNED_DEFLECTIONS) {
    if (pattern.test(reply)) {
      // If most of the reply is the deflection, replace the whole thing.
      const stripped = reply.replace(pattern, '').replace(/\s+/g, ' ').trim();
      if (stripped.length < 20) {
        return SAFE_FALLBACK;
      }
      reply = stripped;
    }
  }

  // Strip em dashes (U+2014) -> comma
  reply = reply.replace(/\u2014/g, ',');
  // Strip en dashes -> hyphen
  reply = reply.replace(/\u2013/g, '-');

  // Strip rocket emoji (banned by user feedback)
  reply = reply.replace(/\s*:rocket:\s*/gi, ' ');
  reply = reply.replace(/\s*\u{1F680}\s*/gu, ' ');

  // Always put a space after a comma, unless it's a numeric thousands
  // separator (e.g. "10,000").
  reply = reply.replace(/,(?!\s)(?!\d)/g, ', ');

  // Normalize smart quotes that Claude sometimes generates
  reply = reply.replace(/[\u2018\u2019]/g, "'");
  reply = reply.replace(/[\u201C\u201D]/g, '"');

  // Strip Notion "View agent" footer if it leaked through
  reply = reply.replace(/\s*View\s+agent\s+in\s+Notion\s*/gi, '');

  // Strip Notion URLs the relay agent appends. This used to match only
  // "www.notion.so/agent/", but the agent actually emits
  // "app.notion.com/agent/..." - so every relay reply carried an internal
  // agent activity URL straight into the channel, and the bare-bracketed-link
  // rule below then rendered it as a clickable "link". Verified in a live
  // relay trace. lib/source-visibility.js is the real gate; this stays as a
  // second layer for replies that don't go through it.
  reply = reply
    .replace(/<?https?:\/\/(?:app\.notion\.com|www\.notion\.so|notion\.so)\/(?:agent|p)\/[^\s>|]*(?:\|[^>]*)?>?/gi, '')
    .trim();

  // The relay agent sometimes wraps links in Slack brackets with no label
  // (`<url|>` or `<url>`), which renders blank or as the raw URL. Always
  // give bracketed links a short label.
  reply = reply.replace(/<(https?:\/\/[^\s|>]+)\|?\s*>/g, (_, url) => `<${url}|${linkLabel(url)}>`);

  // Long/ugly bare URLs (raw Notion calendar links with encoded ids and query
  // strings) read as a wall of text in Slack. Wrap those as a short clickable
  // link. Short, readable bare URLs (a docs page, a case study) are left as
  // they are - seeing the actual domain adds context there.
  reply = reply.replace(
    /(^|[^<])(https?:\/\/[^\s<>]{61,})/g,
    (m, pre, url) => `${pre}<${url}|${linkLabel(url)}>`,
  );

  // Strip raw Slack user IDs (U0APB2TTWKZ etc) that the model should never output.
  // Replace with "someone" so the sentence still reads naturally.
  reply = reply.replace(/\bU[A-Z0-9]{8,12}\b/g, 'someone');
  // Clean up artifacts like "someone , someone" or double "someone someone"
  reply = reply.replace(/\bsomeone\s+someone\b/g, 'someone');

  // Collapse double spaces and trim
  reply = reply.replace(/ {2,}/g, ' ').trim();

  return reply;
}
