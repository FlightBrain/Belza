// Weekday EOD update.
//
// This used to read Notion through the direct API (lib/context.js). That path
// is gone: the key was invalid, so it returned "[unavailable]" for every page
// and this cron could only ever post nothing. It now asks the same Notion AI
// agent the live bot uses, through the relay, which is the one Notion path
// that actually works.
//
// Relay round trips measured 19-31s against the live agent, so maxDuration for
// this function is 60s in vercel.json and the relay gets a 45s budget - enough
// headroom for a slow answer without the invocation being killed mid-post.

import { relayAsk } from '../../lib/relay.js';
import { getRelayConfig } from '../../lib/relay-config.js';
import { postToSlack } from '../../lib/slack.js';
import { applyGuardrails } from '../../lib/guardrails.js';
import { redactForChannel } from '../../lib/source-visibility.js';

const RELAY_BUDGET_MS = 45_000;

const QUESTION =
  'Give a brief end-of-day update for the SDR team: anything notable that ' +
  'changed today in the SDR Hub, upcoming marketing events in the next week, ' +
  'and anything with a deadline this week. Two or three short sentences, ' +
  'casual tone. If there is genuinely nothing notable, reply with exactly: NOTHING';

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel) {
    console.error('proactive-update: SLACK_CHANNEL_ID not set');
    return res.status(500).json({ error: 'no channel configured' });
  }

  const config = getRelayConfig();
  if (!config.enabled) {
    console.log('proactive-update: relay disabled, nothing to do');
    return res.status(200).json({ skipped: 'relay disabled' });
  }

  const result = await relayAsk({ question: QUESTION, timeoutMs: RELAY_BUDGET_MS });

  if (!result) {
    // Timeout or non-answer. Stay silent rather than posting an apology into
    // the channel every weekday morning.
    console.log('proactive-update: no usable answer from relay, staying quiet');
    return res.status(200).json({ posted: false, reason: 'no relay answer' });
  }

  if (/^\s*NOTHING\s*$/i.test(result.answer)) {
    console.log('proactive-update: agent reported nothing notable');
    return res.status(200).json({ posted: false, reason: 'nothing notable' });
  }

  // The relay answer comes from a privileged source; gate it before speaking.
  const visibility = redactForChannel(result.answer, { channelId: channel });
  if (visibility.blocked) {
    console.warn(
      `proactive-update: answer blocked by source-visibility [${visibility.redactions.join(', ')}]`,
    );
    return res.status(200).json({ posted: false, reason: 'source-visibility blocked' });
  }
  if (visibility.redactions.length) {
    console.warn(`proactive-update: redacted [${visibility.redactions.join(', ')}]`);
  }

  const text = applyGuardrails(visibility.text);
  await postToSlack({ channel, text });

  console.log(`proactive-update: posted (relay ${result.latencyMs}ms, request ${result.requestId})`);
  return res.status(200).json({
    posted: true,
    relay_latency_ms: result.latencyMs,
    redactions: visibility.redactions,
  });
}
