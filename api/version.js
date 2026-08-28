// Deploy-drift and config diagnostic.
//
// Phase 0 of the audit could only INFER production config from the local .env,
// and inferred wrong: it reported the relay as disabled when prod had it on.
// Guessing at prod config is how hours get wasted, so the deployment reports
// its own commit and its own effective config.
//
// SECURITY: booleans and non-secret values only. Never echo a token, a key, or
// a signing secret - not even a prefix or a length, which are enough to
// fingerprint a rotation. `configured: true` is all anyone needs.

const present = (name) => Boolean(process.env[name]);

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const relayEnabled = process.env.RELAY_ENABLED === 'true';

  return res.status(200).json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    commit_short: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7),
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    environment: process.env.VERCEL_ENV || 'development',
    deployed_at: process.env.VERCEL_DEPLOYMENT_ID ? undefined : null,

    relay: {
      enabled: relayEnabled,
      channel_id: process.env.RELAY_CHANNEL_ID || 'C0AQCKR9M2S (default)',
      timeout_ms: parseInt(process.env.RELAY_TIMEOUT_MS || '55000', 10),
      poll_interval_ms: parseInt(process.env.RELAY_POLL_INTERVAL_MS || '3000', 10),
      // The important one: an empty allowlist means the poller accepts a reply
      // from ANY responder in the relay channel.
      allowlist: (process.env.RELAY_BOT_USER_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      debug_logging: process.env.RELAY_DEBUG_LOGGING === 'true',
    },

    slack: {
      bot_user_id: process.env.SLACK_BOT_USER_ID || null,
      ambient_channel: process.env.SLACK_CHANNEL_ID || 'C093Z82DK18 (default)',
      token_configured: present('SLACK_BOT_TOKEN'),
      signing_secret_configured: present('SLACK_SIGNING_SECRET'),
    },

    integrations: {
      groq_configured: present('GROQ_API_KEY'),
      braintrust_configured: present('BRAINTRUST_API_KEY'),
      kv_configured: present('KV_REST_API_URL') && present('KV_REST_API_TOKEN'),
      google_calendar_configured:
        present('GOOGLE_CALENDAR_API_KEY') && present('GOOGLE_CALENDAR_IDS'),
      cron_secret_configured: present('CRON_SECRET'),
    },
  });
}
