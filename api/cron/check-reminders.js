// Cron job: checks for due reminders and sends them.
//
// Scheduled "0 9 * * *" in vercel.json - ONCE A DAY, not every 5 minutes as
// this comment used to claim. Vercel Hobby caps cron at once per day per job
// (the same cap that made a scheduled roster refresh useless; see the header
// of lib/roster.js). A reminder can therefore fire up to ~24h late, and the
// bot now says so when setting one. Do not change the schedule here without
// checking the plan - an unsupported cron expression fails the deploy.

import { getDueReminders, markRemindersSent } from '../../lib/reminders.js';
import { postToSlack } from '../../lib/slack.js';

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  const due = await getDueReminders();
  if (due.length === 0) {
    return res.status(200).json({ checked: true, sent: 0 });
  }

  console.log(`reminders: ${due.length} due`);

  const sentIds = [];

  for (const reminder of due) {
    try {
      const text = `hey ${reminder.userName}, reminder: ${reminder.message}`;

      await postToSlack({
        channel: reminder.channel,
        text,
        thread_ts: reminder.threadTs || undefined,
      });

      sentIds.push(reminder.id);
      console.log(`reminders: sent ${reminder.id} to ${reminder.userName}`);
    } catch (e) {
      console.error(`reminders: failed to send ${reminder.id}:`, e.message);
    }
  }

  if (sentIds.length > 0) {
    await markRemindersSent(sentIds);
  }

  return res.status(200).json({ checked: true, sent: sentIds.length });
}
