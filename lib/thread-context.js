// Assembles prior conversation context from Slack before the model sees
// the current message. Handles both threaded and top-level messages.
//
// KEY DESIGN GOAL: the model must NEVER confuse who said what.
// Each message is explicitly labeled with the speaker's real name,
// numbered for easy reference, and prefixed clearly.

import {
  fetchThreadMessages,
  fetchChannelHistory,
  resolveUser,
} from './slack.js';

const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARS = 4000;

export async function buildThreadContext(event) {
  const { channel, ts, thread_ts } = event;
  let messages = [];

  if (thread_ts) {
    // Inside a thread: fetch the full thread (parent + replies).
    messages = await fetchThreadMessages(channel, thread_ts);
  } else {
    // Top-level channel message: grab a small window of recent history.
    messages = await fetchChannelHistory(channel, ts, 10);
  }

  if (!messages || messages.length === 0) return '';

  // Drop the current message itself (it is sent as the user turn).
  messages = messages.filter((m) => m.ts !== ts);

  // Keep only the last N turns to avoid prompt bloat.
  if (messages.length > MAX_CONTEXT_MESSAGES) {
    messages = messages.slice(-MAX_CONTEXT_MESSAGES);
  }

  const botUserId = process.env.SLACK_BOT_USER_ID || '';

  // Pre-resolve all unique user IDs so we batch lookups.
  const userIds = new Set();
  for (const msg of messages) {
    if (msg.user) userIds.add(msg.user);
  }
  const nameMap = new Map();
  for (const uid of userIds) {
    nameMap.set(uid, await resolveUser(uid));
  }

  // Build numbered, clearly attributed message list.
  const formatted = [];
  const participants = new Set();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isBot =
      msg.bot_id || (botUserId && msg.user === botUserId);

    let name;
    if (isBot) {
      name = 'claudesington (you)';
    } else if (msg.user && nameMap.has(msg.user)) {
      name = nameMap.get(msg.user);
    } else {
      name = 'unknown';
    }

    if (!isBot && name !== 'unknown') {
      participants.add(name);
    }

    const text = await resolveInlineMentions(msg.text || '', nameMap);
    if (!text) continue;

    // Include image/file attachments as context.
    const attachments = describeAttachments(msg);
    const fullText = attachments ? `${text} ${attachments}` : text;

    formatted.push(`#${i + 1} [${name}]: ${fullText}`);
  }

  if (formatted.length === 0) return '';

  // Build the final context block with a participant summary.
  const participantList = [...participants].join(', ');
  const header = `people in this thread: ${participantList || 'unknown'}`;

  let body = formatted.join('\n');

  // Trim from the front if the total exceeds the character budget.
  if (body.length > MAX_CONTEXT_CHARS - header.length - 50) {
    const lines = formatted;
    body = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i] + (body ? '\n' + body : '');
      if (candidate.length > MAX_CONTEXT_CHARS - header.length - 50) break;
      body = candidate;
    }
  }

  return `${header}\n\n${body}`;
}

// Resolve <@U123> mentions and Slack formatting inside historical messages.
async function resolveInlineMentions(text, nameMap) {
  if (!text) return '';

  const mentionPattern = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
  const matches = [...text.matchAll(mentionPattern)];
  let resolved = text;
  for (const match of matches) {
    const uid = match[1];
    // Use pre-resolved name if available, otherwise resolve on the fly.
    let name;
    if (nameMap && nameMap.has(uid)) {
      name = nameMap.get(uid);
    } else {
      name = await resolveUser(uid);
    }
    resolved = resolved.replace(match[0], `@${name}`);
  }

  // Channel mentions
  resolved = resolved.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
  resolved = resolved.replace(/<#([A-Z0-9]+)>/g, '#channel');

  // URLs
  resolved = resolved.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2');
  resolved = resolved.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  return resolved;
}

// Describe file/image attachments so the model knows something was shared.
function describeAttachments(msg) {
  const parts = [];

  if (msg.files && msg.files.length > 0) {
    for (const f of msg.files) {
      const type = f.mimetype?.startsWith('image/') ? 'image' : (f.filetype || 'file');
      const name = f.name || f.title || 'untitled';
      parts.push(`[shared ${type}: ${name}]`);
    }
  }

  if (msg.attachments && msg.attachments.length > 0) {
    for (const a of msg.attachments) {
      if (a.image_url) parts.push('[shared image]');
      else if (a.title) parts.push(`[link: ${a.title}]`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : '';
}
