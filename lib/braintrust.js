// Direct Braintrust API logging - bypasses broken SDK logger on Vercel.
//
// Two logging paths:
// 1. logTrace() - called at request time with full context (input, output, notion, etc.)
// 2. logFeedback() - called on thumbs up/down reactions, attaches scores to existing trace

import crypto from 'crypto';

const PROJECT_ID = 'f1bdafc5-2b7c-44c7-bb79-161dc87bf362'; // Braintrust project "Belza"
const API_BASE = 'https://api.braintrust.dev/v1';

async function btFetch(path, body) {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!apiKey) {
    console.warn('bt: BRAINTRUST_API_KEY not set, skipping');
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('bt api error:', res.status, JSON.stringify(data).slice(0, 200));
    }
    return data;
  } catch (e) {
    console.error('bt fetch error:', e.message);
    return null;
  }
}

// Generate a deterministic trace ID from channel + message timestamp.
// This lets reactions (which come later) find and update the same trace.
export function traceId(channel, ts) {
  const hash = crypto.createHash('sha256').update(`${channel}:${ts}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

const toEpochSeconds = (value) => new Date(value).getTime() / 1000;

// Log a full interaction as a root span plus optional child spans (retrieval,
// llm, delivery, ...). Child spans let Braintrust attribute cost/tokens to
// the actual model call (span type "llm") and latency to individual steps,
// instead of everything being flattened into one opaque root event.
//
// spans: [{ name, type, input, output, metadata, error, startTime, endTime,
//            promptTokens, completionTokens, totalTokens }]
export async function logTrace({
  id,
  input,
  output,
  metadata,
  tags,
  scores,
  startTime,
  endTime,
  spans = [],
}) {
  console.log(`bt: logTrace called, id=${id}, has_input=${!!input}, has_output=${!!output}, spans=${spans.length}`);

  const now = new Date();
  const rootSpanId = crypto.randomUUID();

  const rootEvent = {
    ...(id && { id }),
    span_id: rootSpanId,
    root_span_id: rootSpanId,
    is_root: true,
    span_attributes: { name: 'slack_request', type: 'task' },
    input: typeof input === 'string' ? { message: input } : input,
    output: typeof output === 'string' ? { response: output } : output,
    ...(metadata && { metadata }),
    ...(tags && { tags }),
    ...(scores && { scores }),
    metrics: {
      start: startTime ? toEpochSeconds(startTime) : toEpochSeconds(now),
      end: toEpochSeconds(endTime || now),
    },
  };

  const childEvents = spans.filter(Boolean).map((span) => ({
    span_id: crypto.randomUUID(),
    root_span_id: rootSpanId,
    span_parents: [rootSpanId],
    span_attributes: { name: span.name, type: span.type || 'function' },
    input: span.input ?? null,
    output: span.output ?? null,
    ...(span.error && { error: span.error }),
    ...(span.metadata && { metadata: span.metadata }),
    metrics: {
      ...(span.startTime && { start: toEpochSeconds(span.startTime) }),
      ...(span.endTime && { end: toEpochSeconds(span.endTime) }),
      ...(span.promptTokens != null && { prompt_tokens: span.promptTokens }),
      ...(span.completionTokens != null && { completion_tokens: span.completionTokens }),
      ...(span.totalTokens != null && { tokens: span.totalTokens }),
    },
  }));

  const result = await btFetch(`/project_logs/${PROJECT_ID}/insert`, {
    events: [rootEvent, ...childEvents],
  });

  console.log(`bt: logTrace result:`, result ? (result.row_ids ? 'ok' : JSON.stringify(result).slice(0, 150)) : 'null');
  return result;
}

// Attach feedback (thumbs up/down) to an existing trace by ID.
export async function logFeedback({ id, scores, comment, metadata }) {
  console.log(`bt: logFeedback called, id=${id}, thumbs=${scores?.thumbs}`);

  const result = await btFetch(`/project_logs/${PROJECT_ID}/insert`, {
    events: [{
      id,
      scores,
      ...(comment && { metadata: { ...metadata, _comment: comment } }),
      ...(!comment && metadata && { metadata }),
    }],
  });

  console.log(`bt: logFeedback result:`, result ? (result.row_ids ? 'ok' : JSON.stringify(result).slice(0, 150)) : 'null');
  return result;
}
