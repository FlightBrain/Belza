import Anthropic from '@anthropic-ai/sdk';
import { applyGuardrails } from './guardrails.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function callClaude(systemPrompt, cleanedText, { senderName, intent } = {}) {
  const start = Date.now();

  const prefix = senderName
    ? `[${senderName}] says: "${cleanedText}"`
    : `slack message: "${cleanedText}"`;

  // Banter should be short and punchy, not paragraphs.
  const banterIntents = new Set(['banter', 'bot_meta']);
  const maxTokens = banterIntents.has(intent) ? 150 : 400;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: prefix }],
  });

  const latencyMs = Date.now() - start;
  let reply = response.content[0]?.text ?? '';
  reply = applyGuardrails(reply);
  const trimmed = reply.trim() || null;

  return {
    reply: trimmed,
    model: response.model,
    tokens: {
      input: response.usage?.input_tokens,
      output: response.usage?.output_tokens,
    },
    latencyMs,
  };
}
