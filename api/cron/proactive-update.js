import { fetchContext } from '../../lib/context.js';
import { fetchCalendarContext } from '../../lib/calendar.js';
import { getCapabilities, capabilitySummary } from '../../lib/capabilities.js';
import { buildSystemPrompt } from '../../prompts/system.js';
import { callClaude } from '../../lib/claude.js';
import { postToSlack } from '../../lib/slack.js';

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  // Both of these return { text, retrieval }, not a bare string. Passing the
  // object straight through interpolated "[object Object]" into the prompt.
  const [notionResult, calendarResult] = await Promise.all([
    fetchContext(),
    fetchCalendarContext(),
  ]);

  const caps = getCapabilities();
  const systemPrompt = buildSystemPrompt({
    notionContext: notionResult?.text,
    calendarContext: calendarResult?.text,
    capabilities: capabilitySummary(caps),
    intent: 'general_qna',
    threadContext: '',
  });

  const prompt = 'give a brief 1-2 sentence end-of-day update based on the notion context. casual and helpful. if nothing notable is in the context, respond with exactly: [SKIP]';

  // callClaude returns { reply, model, tokens, latencyMs } - the old code
  // compared the whole object against '[SKIP]' (never true) and posted the
  // object as the message text.
  const result = await callClaude(systemPrompt, prompt);
  const message = result?.reply;
  if (!message || message === '[SKIP]') return res.status(200).end();

  await postToSlack({
    channel: process.env.SLACK_CHANNEL_ID,
    text: message,
  });

  return res.status(200).end();
}
