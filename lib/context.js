import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Private/personal pages (e.g. 1:1 notes) must never go here — this context
// gets pulled into replies the bot posts in Slack, visible to anyone who talks to it.
const PAGES = {
  sdrHub: '2bef7858-0289-80f7-a75c-c51d1d3598b1',
  aeModel: '2fdf7858-0289-8077-93f0-d36e1f92d36c',
  marketingEvents: '396f7858-0289-811e-8f86-eeb9a55c57cd',
};

export async function fetchContext() {
  const [hub, model] = await Promise.all([
    fetchPageResult('sdr_hub', PAGES.sdrHub),
    fetchPageResult('ae_model', PAGES.aeModel),
  ]);

  const text = [
    '## current priorities (sdr hub)',
    hub.text.slice(0, 1500),
    '',
    '## ae/sdr model',
    model.text.slice(0, 800),
  ].join('\n');

  return { text, retrieval: [hub, model] };
}

// "H2 Field Marketing Program — At a Glance" — only fetched when the message
// is specifically about marketing events/calendar, not on every message.
export async function fetchMarketingEvents() {
  const result = await fetchPageResult('marketing_events', PAGES.marketingEvents);
  return { text: result.text.slice(0, 2500), retrieval: [result] };
}

// Fetches one Notion page and returns a structured retrieval record —
// status, latency, result count, and failure reason — not just the final
// joined text. This is what makes retrieval failures/gaps visible in traces
// instead of silently collapsing into a "[unavailable]" string.
async function fetchPageResult(name, pageId) {
  const start = Date.now();
  try {
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 50,
    });
    const text = blocksToText(blocks.results);
    return {
      name,
      documentId: pageId,
      status: text ? 'ok' : 'empty',
      text: text || '[unavailable]',
      resultCount: blocks.results.length,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (e) {
    console.error(`notion fetch failed ${pageId}:`, e.message);
    return {
      name,
      documentId: pageId,
      status: 'error',
      text: '[unavailable]',
      resultCount: 0,
      latencyMs: Date.now() - start,
      error: e.message,
    };
  }
}

function blocksToText(blocks) {
  return blocks
    .filter(b => ['paragraph', 'bulleted_list_item', 'heading_2', 'heading_3', 'to_do'].includes(b.type))
    .map(b => {
      const rich = b[b.type]?.rich_text ?? [];
      return rich.map(t => t.plain_text).join('');
    })
    .filter(Boolean)
    .join('\n');
}
