// Fetches today's calendar events for the team via Google Calendar API.
// Requires GOOGLE_CALENDAR_API_KEY and calendar IDs in GOOGLE_CALENDAR_IDS (comma-separated).

export async function fetchCalendarContext() {
  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
  const calendarIds = process.env.GOOGLE_CALENDAR_IDS;

  if (!apiKey || !calendarIds) return '[calendar not configured]';

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const ids = calendarIds.split(',').map(id => id.trim());
  const results = await Promise.all(ids.map(id => fetchCalendar(id, apiKey, startOfDay, endOfDay)));

  return results.filter(Boolean).join('\n') || '[no events today]';
}

async function fetchCalendar(calendarId, apiKey, timeMin, timeMax) {
  try {
    const params = new URLSearchParams({
      key: apiKey,
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.items || data.items.length === 0) return null;

    const ownerName = calendarId.split('@')[0].replace('.', ' ');
    const events = data.items.map(e => {
      const start = e.start?.dateTime || e.start?.date || '';
      const time = start.includes('T') ? new Date(start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : 'all day';
      return `  - ${time}: ${e.summary || 'busy'}`;
    }).join('\n');

    return `${ownerName}:\n${events}`;
  } catch (e) {
    console.error(`calendar fetch failed for ${calendarId}:`, e.message);
    return null;
  }
}
