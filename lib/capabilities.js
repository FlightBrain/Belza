// Declares what data sources the bot actually has access to right now.
// This is checked at runtime so the system prompt can tell Claude
// exactly what it can and cannot answer from.

export function getCapabilities() {
  return {
    slack_connected: !!process.env.SLACK_BOT_TOKEN,
    slack_history: !!process.env.SLACK_BOT_TOKEN,
    notion_connected: !!process.env.NOTION_API_KEY,
    calendar_connected: !!(
      process.env.GOOGLE_CALENDAR_API_KEY && process.env.GOOGLE_CALENDAR_IDS
    ),
    crm_connected: false, // no CRM integration exists yet
  };
}

// Builds a plain-english summary the model can use to self-limit.
export function capabilitySummary(caps) {
  const lines = [];

  if (caps.slack_history) {
    lines.push(
      "- slack thread/channel context: YES. prior messages in this conversation are included below.",
    );
  } else {
    lines.push(
      '- slack thread/channel context: NO. you can only see the current message.',
    );
  }

  if (caps.calendar_connected) {
    lines.push(
      "- calendar: YES. you can see today's events for connected team members.",
    );
  } else {
    lines.push(
      '- calendar: NO. you cannot see anyone\'s calendar or schedule. do not guess whereabouts.',
    );
  }

  if (caps.notion_connected) {
    lines.push(
      '- notion: CONNECTED, but content may be limited. only cite notion data if the context section below has useful content.',
    );
  } else {
    lines.push('- notion: NO. you have no notion access.');
  }

  if (caps.crm_connected) {
    lines.push('- crm/salesforce: YES.');
  } else {
    lines.push(
      '- crm/salesforce: NO. you cannot look up accounts, pipeline, deals, or ownership. do not guess.',
    );
  }

  lines.push(
    '- braintrust.dev: YES. you have customer stories and resource links hardcoded below.',
  );

  return lines.join('\n');
}
