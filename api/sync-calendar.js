// api/sync-calendar.js
//
// Runs only on Vercel's servers. Keeps one combined Google Calendar event
// per day in sync with whatever's assigned in the app for that date —
// 6:00-7:00 PM Central, titled with the meal name(s), no description.
//
// Required Vercel env vars (Project Settings -> Environment Variables):
//   GOOGLE_CLIENT_SECRET  - from your Google Cloud OAuth client
//   GOOGLE_REFRESH_TOKEN  - printed by get-refresh-token.js
//
// The mapping between a date and its Google Calendar event id is kept in a
// small Supabase table, "calendar_sync" (see the chat message for the SQL).

const SUPABASE_URL = "https://cyxnxoeerlxanjltxhdp.supabase.co";
const SUPABASE_KEY = "sb_publishable_4jQAFzZO52uLigenwuJ9Ng_iVxVgXHm";

const GOOGLE_CLIENT_ID = "2404932190-gf5ecgokngljmg7pqcac0r6eap15u31p.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CALENDAR_ID = "1t6h34ua8h8linvv3pe86ac4cg@group.calendar.google.com";
const EVENT_TIMEZONE = "America/Chicago";

async function requireLoggedInUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getGoogleAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || "Couldn't refresh Google access token");
  return data.access_token;
}

// --- small helpers for reading/writing the date -> event id mapping in Supabase ---

async function getSyncRow(date, userToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/calendar_sync?date=eq.${date}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${userToken}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function upsertSyncRow(date, eventId, userToken) {
  await fetch(`${SUPABASE_URL}/rest/v1/calendar_sync?on_conflict=date`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ date, google_event_id: eventId }),
  });
}

async function deleteSyncRow(date, userToken) {
  await fetch(`${SUPABASE_URL}/rest/v1/calendar_sync?date=eq.${date}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${userToken}` },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return res.status(500).json({ error: "Server is missing Google credentials in Vercel env vars." });
  }

  const authHeader = req.headers.authorization || "";
  const userToken = authHeader.replace("Bearer ", "").trim();
  const caller = await requireLoggedInUser(userToken);
  if (!caller) {
    return res.status(401).json({ error: "You must be signed in to sync the calendar." });
  }

  const { date, recipeNames } = req.body || {};
  if (!date) return res.status(400).json({ error: "A date is required." });
  const names = Array.isArray(recipeNames) ? recipeNames.filter(Boolean) : [];

  try {
    const googleToken = await getGoogleAccessToken();
    const existing = await getSyncRow(date, userToken);
    const gcalHeaders = { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" };
    const eventsBase = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`;

    if (names.length === 0) {
      // Nothing assigned to this day anymore — remove the event if one exists.
      if (existing && existing.google_event_id) {
        await fetch(`${eventsBase}/${existing.google_event_id}`, { method: "DELETE", headers: gcalHeaders });
        await deleteSyncRow(date, userToken);
      }
      return res.status(200).json({ ok: true, action: "cleared" });
    }

    const eventBody = {
      summary: names.join(", "),
      start: { dateTime: `${date}T18:00:00`, timeZone: EVENT_TIMEZONE },
      end: { dateTime: `${date}T19:00:00`, timeZone: EVENT_TIMEZONE },
    };

    if (existing && existing.google_event_id) {
      const patchRes = await fetch(`${eventsBase}/${existing.google_event_id}`, {
        method: "PATCH",
        headers: gcalHeaders,
        body: JSON.stringify(eventBody),
      });
      if (patchRes.status === 404) {
        // Event was deleted on the Google Calendar side directly — recreate it.
        const createRes = await fetch(eventsBase, { method: "POST", headers: gcalHeaders, body: JSON.stringify(eventBody) });
        const created = await createRes.json();
        if (!createRes.ok) throw new Error(created.error?.message || "Couldn't create calendar event");
        await upsertSyncRow(date, created.id, userToken);
      } else if (!patchRes.ok) {
        const data = await patchRes.json().catch(() => ({}));
        throw new Error(data.error?.message || "Couldn't update calendar event");
      }
    } else {
      const createRes = await fetch(eventsBase, { method: "POST", headers: gcalHeaders, body: JSON.stringify(eventBody) });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created.error?.message || "Couldn't create calendar event");
      await upsertSyncRow(date, created.id, userToken);
    }

    return res.status(200).json({ ok: true, action: "synced" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}