import { applyGuardrails } from './guardrails.js';

const GROQ_MODEL = 'openai/gpt-oss-20b';

// Groq's on-demand tier caps tokens-per-minute, and one reply costs roughly
// 2.5k of an 8k/min budget - about three replies a minute for the whole
// workspace. Without a retry the fourth person to talk to the bot in the same
// minute got "hit a snag on my end", which reads as the bot being broken
// rather than busy. Honor Retry-After (Groq sends it in seconds), falling back
// to the wait it names in the error message.
const MAX_RETRIES = 3;
// TOTAL sleep budget across all retries, not per attempt. A per-attempt cap
// was useless: 3 attempts x 24s each is 72s of sleeping inside a function with
// a 60s maxDuration, so the invocation was killed and NOTHING was posted -
// strictly worse than the old behavior, where a single 429 threw immediately
// and the caller's "hit a snag on my end" fallback actually got delivered.
const TOTAL_WAIT_BUDGET_MS = 20_000;
// Per-attempt network timeout. Groq normally answers in 1-3s.
const REQUEST_TIMEOUT_MS = 15_000;

function retryDelayMs(res, payload) {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = parseFloat(header);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  }
  const named = /try again in ([\d.]+)s/i.exec(payload?.error?.message || '');
  if (named) return Math.ceil(parseFloat(named[1]) * 1000);
  return 2000;
}

async function postWithRetry(body) {
  let last;
  let spent = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      // Without this a hung Groq connection holds the invocation until Vercel
      // kills it at 60s: no reply, no error, no trace - a failure detectable
      // only by its absence. A timeout turns that into a thrown error the
      // caller already handles with a graceful reply.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const response = await res.json();
    last = { res, response };

    if (res.status !== 429 || attempt === MAX_RETRIES) return last;

    const wait = retryDelayMs(res, response);
    if (spent + wait > TOTAL_WAIT_BUDGET_MS) {
      console.warn(
        `groq: 429 wants ${wait}ms but ${spent}ms already spent of ` +
          `${TOTAL_WAIT_BUDGET_MS}ms budget, giving up so the caller can degrade`,
      );
      return last;
    }
    spent += wait;
    console.warn(`groq: 429, waiting ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES}, ${spent}ms spent)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

export async function callClaude(systemPrompt, cleanedText, { senderName, intent } = {}) {
  const start = Date.now();

  const prefix = senderName
    ? `[${senderName}] says: "${cleanedText}"`
    : `slack message: "${cleanedText}"`;

  // Banter should be short and punchy, not paragraphs.
  const banterIntents = new Set(['banter', 'bot_meta']);
  const maxTokens = banterIntents.has(intent) ? 150 : 400;

  const body = JSON.stringify({
    model: GROQ_MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prefix },
    ],
  });

  const { res, response } = await postWithRetry(body);
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${JSON.stringify(response).slice(0, 300)}`);
  }

  const latencyMs = Date.now() - start;
  const raw = response.choices?.[0]?.message?.content ?? '';
  const reply = applyGuardrails(raw);
  const trimmed = reply.trim() || null;

  return {
    reply: trimmed,
    // The model's output BEFORE applyGuardrails. Identity tests must assert
    // against this: applyGuardrails rewrites /U[A-Z0-9]{8,12}/ to "someone",
    // which would silently convert a failed identity resolution into a
    // plausible-looking sentence and hide the bug.
    rawReply: raw,
    model: response.model,
    tokens: {
      input: response.usage?.prompt_tokens,
      output: response.usage?.completion_tokens,
    },
    latencyMs,
  };
}
