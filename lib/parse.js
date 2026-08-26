// Cleans Slack message text so the model sees the actual question.
// Strips the BOT's own mention (it's a trigger, not content) but
// preserves other user/channel mentions as readable references.

export function cleanSlackText(text) {
  if (!text) return '';

  const botId = process.env.SLACK_BOT_USER_ID || '';
  let cleaned = text;

  // 1. Strip the bot's own @mention (trigger, not part of the question).
  if (botId) {
    cleaned = cleaned.replace(
      new RegExp(`<@${botId}(?:\\\\|[^>]*)?>`, 'g'),
      '',
    );
  }

  // 2. Convert OTHER user mentions to @displayName.
  cleaned = cleaned.replace(
    /<@([A-Z0-9]+)(?:\|([^>]+))?>/g,
    (_, id, label) => (label ? `@${label}` : `@${id}`),
  );

  // 3. Channel mentions -> #channel-name.
  cleaned = cleaned.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
  cleaned = cleaned.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // 4. URLs: keep both label and href for context.
  cleaned = cleaned.replace(
    /<(https?:\/\/[^|>]+)\|([^>]+)>/g,
    '$2 ($1)',
  );
  cleaned = cleaned.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // 5. Normalize encoding artifacts from macOS/mobile keyboards.
  cleaned = normalizeInput(cleaned);

  // 6. Collapse whitespace.
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

// Normalize special characters that come in from macOS/mobile keyboards
// and cause downstream parsing issues or garbled model output.
function normalizeInput(text) {
  let out = text;

  // Smart quotes -> straight quotes
  out = out.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');

  // Em/en dashes -> plain dashes
  out = out.replace(/[\u2014\u2013]/g, '-');

  // Ellipsis -> three dots
  out = out.replace(/\u2026/g, '...');

  // Non-breaking space -> regular space
  out = out.replace(/\u00A0/g, ' ');

  // Zero-width chars
  out = out.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');

  return out;
}
