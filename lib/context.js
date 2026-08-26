import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const PAGES = {
  sdrHub: '2bef7858-0289-80f7-a75c-c51d1d3598b1',
  aeModel: '2fdf7858-0289-8077-93f0-d36e1f92d36c',
  jayOneOnOne: 'c33fa67a-c5c4-46e8-98a8-2c7a750176bd',
};

export async function fetchContext() {
  const [hub, model, jay] = await Promise.all([
    fetchPageText(PAGES.sdrHub),
    fetchPageText(PAGES.aeModel),
    fetchPageText(PAGES.jayOneOnOne),
  ]);

  return [
    '## current priorities (sdr hub)',
    hub.slice(0, 1500),
    '',
    '## ae/sdr model',
    model.slice(0, 800),
    '',
    '## jay 1:1 notes',
    jay.slice(0, 1200),
  ].join('\n');
}

async function fetchPageText(pageId) {
  try {
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 50,
    });
    return blocksToText(blocks.results);
  } catch (e) {
    console.error(`notion fetch failed ${pageId}:`, e.message);
    return '[unavailable]';
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
