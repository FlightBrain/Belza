import crypto from 'crypto';

export function verifySlackSignature(req, rawBody) {
  const slackSig = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (!slackSig || !timestamp) return false;

  // Reject stale requests (replay attack prevention)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBase, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(slackSig, 'utf8')
    );
  } catch {
    return false;
  }
}

// Convert standard markdown to Slack mrkdwn before posting.
export function toSlackMrkdwn(text) {
  if (!text) return text;
  return text
    // **bold** -> *bold*
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    // ## headers -> *bold* line (Slack has no header rendering)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Remove horizontal rules
    .replace(/^-{3,}$/gm, '');
}

export async function postToSlack({ channel, text, thread_ts, metadata }) {
  const formatted = toSlackMrkdwn(text);

  const body = {
    channel,
    text: formatted,
    ...(thread_ts && { thread_ts }),
    ...(metadata && { metadata }),
  };

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) console.error('Slack post failed:', data.error);
  if (metadata && !data.ok) console.error('Slack metadata may have failed:', JSON.stringify(metadata));
  return data;
}

// --- Single message fetch (for reading metadata on reactions) ---

export async function fetchMessage(channel, ts) {
  try {
    const params = new URLSearchParams({
      channel,
      latest: ts,
      limit: '1',
      inclusive: 'true',
      include_all_metadata: 'true',
    });
    const res = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('fetchMessage failed:', data.error);
      return null;
    }
    return data.messages?.[0] || null;
  } catch (e) {
    console.error('fetchMessage error:', e.message);
    return null;
  }
}

// --- Thread & channel history ---

export async function fetchThreadMessages(channel, threadTs) {
  try {
    const params = new URLSearchParams({
      channel,
      ts: threadTs,
      limit: '50',
      inclusive: 'true',
    });
    const res = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('Thread fetch failed:', data.error);
      return [];
    }
    return data.messages || [];
  } catch (e) {
    console.error('Thread fetch error:', e.message);
    return [];
  }
}

export async function fetchChannelHistory(channel, beforeTs, limit = 8) {
  try {
    const params = new URLSearchParams({
      channel,
      limit: String(limit),
      inclusive: 'true',
    });
    if (beforeTs) params.set('latest', beforeTs);

    const res = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('Channel history fetch failed:', data.error);
      return [];
    }
    // API returns newest-first; reverse to chronological
    return (data.messages || []).reverse();
  } catch (e) {
    console.error('Channel history error:', e.message);
    return [];
  }
}

// --- User resolution ---

const userCache = new Map();

export async function resolveUser(userId) {
  if (!userId) return 'unknown';
  if (userCache.has(userId)) return userCache.get(userId);

  try {
    const res = await fetch(
      `https://slack.com/api/users.info?user=${userId}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
    );
    const data = await res.json();
    if (!data.ok) {
      userCache.set(userId, userId);
      return userId;
    }
    const name =
      data.user?.profile?.display_name ||
      data.user?.real_name ||
      data.user?.name ||
      userId;
    userCache.set(userId, name);
    return name;
  } catch {
    userCache.set(userId, userId);
    return userId;
  }
}

// Exported for testing
export function _clearUserCache() {
  userCache.clear();
}
