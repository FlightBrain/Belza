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

// --- Generic GET helper with 429 handling ---
//
// The older fetch helpers below each roll their own call and treat a 429 as
// a plain failure. The roster fan-out can issue dozens of calls, so it needs
// a helper that actually honors Retry-After rather than silently returning an
// empty member list (which would look like "the channel has no members").
//
// Throws on a non-ok Slack response so callers can distinguish "the API said
// no" from "the channel is genuinely empty".
// totalWaitBudgetMs bounds the SUM of all sleeps, not each one. This runs
// synchronously in the request path (a cold roster cache calls
// conversations.members before the bot can reply), and Slack's Retry-After on
// a Tier-2 method can be 60s. With no cap, three attempts slept 180s inside a
// function with a 60s maxDuration - the invocation was killed and the user got
// nothing at all. Better to give up fast and let the caller degrade.
export async function slackApi(
  method,
  params = {},
  { maxRetries = 3, totalWaitBudgetMs = 8000 } = {},
) {
  const query = new URLSearchParams(params);
  let spent = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}?${query}`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });

    if (res.status === 429) {
      // Slack documents Retry-After in seconds. Default to 1s if absent.
      const wait = (parseInt(res.headers.get('retry-after') || '1', 10) || 1) * 1000;
      if (attempt === maxRetries) {
        throw new Error(`${method} rate limited, retries exhausted`);
      }
      if (spent + wait > totalWaitBudgetMs) {
        throw new Error(
          `${method} rate limited, Retry-After ${wait}ms exceeds remaining ` +
            `budget (${spent}/${totalWaitBudgetMs}ms spent)`,
        );
      }
      spent += wait;
      console.warn(`slack: 429 on ${method}, waiting ${wait}ms (attempt ${attempt + 1}, ${spent}ms spent)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const data = await res.json();
    if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
    return data;
  }

  throw new Error(`${method} failed after ${maxRetries} retries`);
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
