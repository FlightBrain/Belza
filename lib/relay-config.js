// Relay configuration from environment variables.
// Defaults tuned for the #kensington-belza channel relay pattern.

// The Notion AI agent's bot_id. Verified against every relay reply in the
// channel's history. Override with RELAY_BOT_USER_IDS if the agent is
// replaced; set it to a single space to deliberately accept anyone (don't).
const DEFAULT_RESPONDER_IDS = ['B071TMT4A0N'];

// The function has 60s total (vercel.json maxDuration). By the time the relay
// starts we have already spent time on the thread fetch, the roster, thread
// context and the filler post, and we still need time to post the answer
// afterwards. Polling for the full 55s from that point overruns the
// invocation and the user is left with the filler and nothing else - the worst
// visible failure this bot has, because the filler is an explicit promise.
//
// Measured relay latency is 18.8s-31.2s over 14 real round trips, so a 48s
// poll window still clears the slow tail with margin.
const FUNCTION_BUDGET_MS = 60_000;
const NON_RELAY_OVERHEAD_MS = 12_000;

export function getRelayConfig() {
  const requested = parseInt(process.env.RELAY_TIMEOUT_MS || '55000', 10);
  const ceiling = FUNCTION_BUDGET_MS - NON_RELAY_OVERHEAD_MS;
  return {
    enabled: process.env.RELAY_ENABLED === 'true',
    channelId: process.env.RELAY_CHANNEL_ID || 'C0AQCKR9M2S',
    timeoutMs: Math.min(requested, ceiling),
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
