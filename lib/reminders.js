// KV-backed reminder system. Users ask the bot to remind them about
// something, the bot stores it, and a cron job checks every 5 minutes
// for due reminders and sends them as Slack DMs or thread replies.

import { kv } from '@vercel/kv';

const REMINDERS_KEY = 'reminders:pending';

const kvAvailable = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const memoryFallback = [];

// ---- public API ----

// Create a new reminder.
export async function createReminder({
  userId,
  userName,
  channel,
  threadTs,
  message,
  triggerAt,  // ISO string or Date
}) {
  const reminder = {
    id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    userName: userName || userId,
    channel,
    threadTs: threadTs || null,
    message,
    triggerAt: typeof triggerAt === 'string' ? triggerAt : triggerAt.toISOString(),
    createdAt: new Date().toISOString(),
    sent: false,
  };

  const list = await getAllReminders();
  list.push(reminder);
  await saveReminders(list);

  console.log(`reminder: created ${reminder.id} for ${userName} at ${reminder.triggerAt}`);
  return reminder;
}

// Get all pending (unsent) reminders that are due.
export async function getDueReminders() {
  const now = new Date().toISOString();
  const list = await getAllReminders();
  return list.filter(r => !r.sent && r.triggerAt <= now);
}

// Mark reminders as sent.
export async function markRemindersSent(ids) {
  const list = await getAllReminders();
  for (const r of list) {
    if (ids.includes(r.id)) r.sent = true;
  }
  // Prune sent reminders older than 24h to keep the list clean.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const pruned = list.filter(r => !r.sent || r.triggerAt > cutoff);
  await saveReminders(pruned);
}

// Get all reminders for a specific user (for "list my reminders").
export async function getUserReminders(userId) {
  const list = await getAllReminders();
  return list.filter(r => r.userId === userId && !r.sent);
}

// ---- parsing ----

// Try to parse a natural-language time reference into a Date.
// All times are interpreted as Pacific Time (America/Los_Angeles).
// Handles: "in 30 minutes", "in 2 hours", "tomorrow at 9am",
// "at 3pm", "in 1 hour", "next monday".

// Get current time in PT as a manipulable Date.
function nowPT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

// Build a Date in PT and convert to UTC for storage.
function ptToUTC(year, month, day, hours, minutes) {
  // Create an ISO string in PT, then let Date parse it as local.
  // Trick: build date string, parse it as if PT.
  const dtStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
  // Use Intl to get the UTC offset for PT at this date
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  // Create a date in UTC, then adjust for PT offset
  const utcGuess = new Date(dtStr + 'Z');
  const ptParts = fmt.formatToParts(utcGuess);
  const ptHour = parseInt(ptParts.find(p => p.type === 'hour').value);
  const diff = ptHour - hours;
  // Adjust: if PT shows a different hour than what we want, shift
  return new Date(utcGuess.getTime() - diff * 3600 * 1000);
}

export function parseReminderTime(text) {
  const now = new Date(); // real UTC now
  const pt = nowPT();     // current time in PT

  // "in X minutes/hours/days" - relative, no timezone issue
  const inMatch = text.match(/\bin\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?|days?)\b/i);
  if (inMatch) {
    const num = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    if (unit.startsWith('min')) return new Date(now.getTime() + num * 60 * 1000);
    if (unit.startsWith('h')) return new Date(now.getTime() + num * 3600 * 1000);
    if (unit.startsWith('d')) return new Date(now.getTime() + num * 86400 * 1000);
  }

  // "at Xam/pm" or "at X:XXam/pm" (today or tomorrow if past) - PT
  const atMatch = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (atMatch) {
    let hours = parseInt(atMatch[1]);
    const minutes = parseInt(atMatch[2] || '0');
    const ampm = atMatch[3].toLowerCase();
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    let target = ptToUTC(pt.getFullYear(), pt.getMonth(), pt.getDate(), hours, minutes);
    if (target <= now) target = new Date(target.getTime() + 86400 * 1000);
    return target;
  }

  // "tomorrow" (default 9am PT)
  if (/\btomorrow\b/i.test(text)) {
    const tmrw = new Date(pt);
    tmrw.setDate(tmrw.getDate() + 1);

    const timeMatch = text.match(/tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2] || '0');
      const ap = timeMatch[3].toLowerCase();
      if (ap === 'pm' && h !== 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      return ptToUTC(tmrw.getFullYear(), tmrw.getMonth(), tmrw.getDate(), h, m);
    }
    return ptToUTC(tmrw.getFullYear(), tmrw.getMonth(), tmrw.getDate(), 9, 0);
  }

  // "next monday/tuesday/..." (default 9am PT)
  const dayMatch = text.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dayMatch) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = dayNames.indexOf(dayMatch[1].toLowerCase());
    const currentDay = pt.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    const target = new Date(pt);
    target.setDate(target.getDate() + daysAhead);
    return ptToUTC(target.getFullYear(), target.getMonth(), target.getDate(), 9, 0);
  }

  // "end of day" / "eod" (5pm PT)
  if (/\b(eod|end\s+of\s+day)\b/i.test(text)) {
    let target = ptToUTC(pt.getFullYear(), pt.getMonth(), pt.getDate(), 17, 0);
    if (target <= now) target = new Date(target.getTime() + 86400 * 1000);
    return target;
  }

  return null;
}

// ---- internals ----

async function getAllReminders() {
  try {
    if (kvAvailable) {
      return (await kv.get(REMINDERS_KEY)) || [];
    }
    return [...memoryFallback];
  } catch (e) {
    console.error('reminders: get failed:', e.message);
    return [...memoryFallback];
  }
}

async function saveReminders(list) {
  try {
    if (kvAvailable) {
      await kv.set(REMINDERS_KEY, list, { ex: 30 * 24 * 3600 }); // 30-day TTL
    }
    memoryFallback.length = 0;
    memoryFallback.push(...list);
  } catch (e) {
    console.error('reminders: save failed:', e.message);
  }
}

// ---- test helpers ----
export function _resetReminders() {
  memoryFallback.length = 0;
}
