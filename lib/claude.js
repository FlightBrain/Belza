import { applyGuardrails } from './guardrails.js';

const GROQ_MODEL = 'openai/gpt-oss-20b';

export async function callClaude(systemPrompt, cleanedText, { senderName, intent } = {}) {
  const start = Date.now();

  const prefix = senderName
    ? `[${senderName}] says: "${cleanedText}"`
    : `slack message: "${cleanedText}"`;

  // Banter should be short and punchy, not paragraphs.
  const banterIntents = new Set(['banter', 'bot_meta']);
  const maxTokens = banterIntents.has(intent) ? 150 : 400;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prefix },
      ],
    }),
  });

  const response = await res.json();
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${JSON.stringify(response).slice(0, 300)}`);
  }

  const latencyMs = Date.now() - start;
  let reply = response.choices?.[0]?.message?.content ?? '';
  reply = applyGuardrails(reply);
  const trimmed = reply.trim() || null;

  return {
    reply: trimmed,
    model: response.model,
    tokens: {
      input: response.usage?.prompt_tokens,
      output: response.usage?.completion_tokens,
    },
    latencyMs,
  };
}
