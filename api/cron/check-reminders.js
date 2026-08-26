// Cron job: runs every 5 minutes, checks for due reminders, sends them.

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
