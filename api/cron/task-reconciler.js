// Morning task audit cron. Runs weekdays at 9am PT.
// Queries the Notion Task Tracker directly, surfaces top priority work,
// flags duplicates, and calls out tasks that were probably already done.

import { Client } from '@notionhq/client';
import { postToSlack } from '../../lib/slack.js';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Database ID for Kensington's Task Tracker
const TASK_DB_ID = '2a0f7858-0289-808f-b2ec-000b0bcb0cb3';

// Outreach tasks for blocked companies should not exist - flag them
const BLOCKED_COMPANIES = [
  'cisco', 'meta', 'hsbc', 'splunk', 'tableau', 'instagram', 'carta',
  'databricks', 'informatica', 'venmo', 'facebook', 'liveramp', 'mercado libre',
  'nec x', 'audible', 'nvidia', 'tao digital', 'microsoft', 'stripe', 'zoominfo',
  'dialpad', 'rivian', 'activision', 'adobe', 'commure', 'pigment', 'salesforce',
  'cloudflare', 'netflix', 'supabase', 'replit', 'mcafee', 'mercor', 'asana',
  'bill.com', 'appsflyer', 'robinhood', 'sofi', 'paypal', 'redfin', 'github',
  'dbt labs', 'investcloud',
];

function isBlocked(name) {
  const lower = (name || '').toLowerCase();
  return BLOCKED_COMPANIES.some(co => lower.includes(co));
}

// Extract "person at company" fingerprint for dedup matching
function fingerprint(name) {
  const m = name.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+at\s+([A-Z][a-zA-Z0-9\s]+)/);
  if (!m) return null;
  return `${m[1].toLowerCase().trim()}|${m[2].toLowerCase().trim()}`;
}

function extractTask(page) {
  const p = page.properties;
  return {
    id: page.id,
    name: p['Task name']?.title?.[0]?.plain_text || '(untitled)',
    status: p['Status']?.status?.name || 'Unknown',
    dueDate: p['Due date']?.date?.start || null,
    requestedBy: p['Requested By']?.rich_text?.[0]?.plain_text || null,
  };
}

function dateEmoji(dueDate) {
  if (!dueDate) return '⚪';
  const dueMs = new Date(dueDate + 'T12:00:00Z').getTime();
  const diff = dueMs - Date.now();
  if (diff < 0) return '🔴';
  if (diff < 2 * 86400000) return '🟠';
  if (diff < 7 * 86400000) return '🟡';
  return '🟢';
}

function fmtDate(d) {
  if (!d) return 'no due date';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function queryTasks(filterStatus) {
  try {
    const filter = filterStatus === 'open'
      ? { property: 'Status', status: { does_not_equal: 'Done' } }
      : { property: 'Status', status: { equals: 'Done' } };

    const res = await notion.databases.query({
      database_id: TASK_DB_ID,
      filter,
      sorts: [{ property: 'Due date', direction: 'ascending' }],
      page_size: 100,
    });
    return res.results.map(extractTask);
  } catch (e) {
    console.error(`task-reconciler: notion query failed (${filterStatus}):`, e.message);
    return [];
  }
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  const [openTasks, doneTasks] = await Promise.all([
    queryTasks('open'),
    queryTasks('done'),
  ]);

  if (openTasks.length === 0) {
    console.log('task-reconciler: no open tasks');
    return res.status(200).json({ tasks: 0 });
  }

  // Build done fingerprint set for dedup detection
  const doneFingerprints = new Set(doneTasks.map(t => fingerprint(t.name)).filter(Boolean));

  // Sort: overdue first, then by date, unscheduled last
  const sorted = [...openTasks].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  // Detect duplicates: same fingerprint among open tasks
  const fpMap = {};
  const dupes = [];
  const seenDupePairs = new Set();
  for (const t of sorted) {
    const fp = fingerprint(t.name);
    if (!fp) continue;
    if (fpMap[fp]) {
      const pairKey = [fpMap[fp].id, t.id].sort().join(':');
      if (!seenDupePairs.has(pairKey)) {
        seenDupePairs.add(pairKey);
        dupes.push({ a: fpMap[fp], b: t });
      }
    } else {
      fpMap[fp] = t;
    }
  }

  // Detect recreated-after-done
  const recreated = sorted.filter(t => {
    const fp = fingerprint(t.name);
    return fp && doneFingerprints.has(fp);
  });

  // Detect blocked company tasks
  const blocked = sorted.filter(t => isBlocked(t.name));
  const clean = sorted.filter(t => !isBlocked(t.name));

  // Split: due within 7 days vs. unscheduled/later
  const nowMs = Date.now();
  const urgent = clean.filter(t => {
    if (!t.dueDate) return false;
    return new Date(t.dueDate + 'T12:00:00Z').getTime() - nowMs < 7 * 86400000;
  });
  const unscheduled = clean.filter(t => !t.dueDate);
  const later = clean.filter(t => {
    if (!t.dueDate) return false;
    return new Date(t.dueDate + 'T12:00:00Z').getTime() - nowMs >= 7 * 86400000;
  });

  const lines = ['*task audit*'];

  // This week
  if (urgent.length > 0) {
    lines.push('\n*this week:*');
    for (const t of urgent.slice(0, 8)) {
      const by = t.requestedBy ? ` (${t.requestedBy})` : '';
      lines.push(`${dateEmoji(t.dueDate)} ${t.name} - ${fmtDate(t.dueDate)}${by}`);
    }
  }

  // Later
  if (later.length > 0) {
    lines.push(`\n*coming up (${later.length}):*`);
    for (const t of later.slice(0, 4)) {
      lines.push(`🟢 ${t.name} - ${fmtDate(t.dueDate)}`);
    }
    if (later.length > 4) lines.push(`  ...+${later.length - 4} more`);
  }

  // Unscheduled
  if (unscheduled.length > 0) {
    lines.push(`\n⚪ *unscheduled (${unscheduled.length}):*`);
    for (const t of unscheduled.slice(0, 3)) {
      lines.push(`  - ${t.name}`);
    }
    if (unscheduled.length > 3) lines.push(`  ...+${unscheduled.length - 3} more`);
  }

  // Duplicates
  if (dupes.length > 0) {
    lines.push('\n*duplicate tasks (clean up):*');
    for (const d of dupes.slice(0, 3)) {
      lines.push(`- "${d.a.name}" / "${d.b.name}"`);
    }
  }

  // Done-but-recreated
  if (recreated.length > 0) {
    lines.push('\n*already marked done recently:*');
    for (const t of recreated.slice(0, 3)) {
      lines.push(`- "${t.name}" (mark done again or delete)`);
    }
  }

  // Blocked company tasks
  if (blocked.length > 0) {
    lines.push('\n*blocked company tasks (delete these):*');
    for (const t of blocked) {
      lines.push(`- ${t.name}`);
    }
  }

  lines.push(`\n_${openTasks.length} open | ${doneTasks.length} done recently_`);

  const channel = process.env.SLACK_CHANNEL_ID || 'C0AQCKR9M2S';
  await postToSlack({ channel, text: lines.join('\n') });

  console.log(`task-reconciler: done. open=${openTasks.length} dupes=${dupes.length} recreated=${recreated.length} blocked=${blocked.length}`);
  return res.status(200).json({
    open: openTasks.length,
    dupes: dupes.length,
    recreated: recreated.length,
    blocked: blocked.length,
  });
}
