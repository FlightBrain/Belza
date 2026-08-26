// Relay configuration from environment variables.
// Defaults tuned for the #kensington-belza channel relay pattern.

export function getRelayConfig() {
  return {
    enabled: process.env.RELAY_ENABLED === 'true',
    channelId: process.env.RELAY_CHANNEL_ID || 'C0AQCKR9M2S',
    timeoutMs: parseInt(process.env.RELAY_TIMEOUT_MS || '55000', 10),
    pollIntervalMs: parseInt(process.env.RELAY_POLL_INTERVAL_MS || '3000', 10),
    requestPrefix:
      process.env.RELAY_REQUEST_PREFIX || '[CLAUDESINGTON_RELAY_REQUEST]',
    botUserIds: (process.env.RELAY_BOT_USER_IDS || '')
      .split(',')
      .filter(Boolean),
    debugLogging: process.env.RELAY_DEBUG_LOGGING === 'true',
  };
}
