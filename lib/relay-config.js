// Relay configuration from environment variables.
// Defaults tuned for the #kensington-belza channel relay pattern.

// The Notion AI agent's bot_id. Verified against every relay reply in the
// channel's history. Override with RELAY_BOT_USER_IDS if the agent is
// replaced; set it to a single space to deliberately accept anyone (don't).
const DEFAULT_RESPONDER_IDS = ['B071TMT4A0N'];

export function getRelayConfig() {
  return {
    enabled: process.env.RELAY_ENABLED === 'true',
    channelId: process.env.RELAY_CHANNEL_ID || 'C0AQCKR9M2S',
    timeoutMs: parseInt(process.env.RELAY_TIMEOUT_MS || '55000', 10),
    pollIntervalMs: parseInt(process.env.RELAY_POLL_INTERVAL_MS || '3000', 10),
    requestPrefix:
      process.env.RELAY_REQUEST_PREFIX || '[CLAUDESINGTON_RELAY_REQUEST]',
    // Who is allowed to answer a relay request.
    //
    // This used to default to EMPTY, which the poller treated as "accept
    // anyone", and the poller also accepted any reply over 10 characters as a
    // fallback. #kensington-belza has Zapier bots and humans posting in it, so
    // an unrelated message landing in a relay thread could be lifted verbatim
    // and spoken as a grounded answer.
    //
    // B071TMT4A0N is the Notion AI agent, confirmed as the responder on all
    // 11 real relay round trips in the channel's history. Note it replies with
    // bot_id set and user null, so the poller matches on bot_id.
    botUserIds: (process.env.RELAY_BOT_USER_IDS || DEFAULT_RESPONDER_IDS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    debugLogging: process.env.RELAY_DEBUG_LOGGING === 'true',
  };
}
