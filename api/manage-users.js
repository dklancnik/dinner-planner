// api/manage-users.js
//
// This file runs ONLY on Vercel's servers, never in the browser — it's the
// one place the Supabase "service role" key is allowed to exist. The React
// app never sees that key; it just calls this endpoint with the logged-in
// user's own session token, and this function does the privileged work.
//
// Required Vercel setup (see the chat message for full steps):
//   1. Deploy this file at api/manage-users.js in your project.
//   2. In Vercel: Project Settings -> Environment Variables, add
//      SUPABASE_SERVICE_ROLE_KEY = <the service_role key from Supabase>
//      (Settings -> API in your Supabase project). Do NOT prefix it with
//      VITE_ — that would leak it into the browser bundle.
//   3. Redeploy after adding the env var.

const SUPABASE_URL = "https://cyxnxoeerlxanjltxhdp.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_4jQAFzZO52uLigenwuJ9Ng_iVxVgXHm";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Confirms the request is coming from someone who is actually logged into
// the app (any logged-in user is allowed, per how this was scoped).
async function requireLoggedInUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY — add it in Vercel's env vars." });
  }

  const caller = await requireLoggedInUser(req);
  if (!caller) {
    return res.status(401).json({ error: "You must be signed in to manage users." });
  }

  const { action, ...payload } = req.body || {};

  const adminHeaders = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    if (action === "list") {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, { headers: adminHeaders });
      const data = await r.json();
      if (!r.ok) throw new Error(data.msg || "Couldn't list users");
      const users = (data.users || []).map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
      }));
      return res.status(200).json({ users });
    }

    if (action === "create") {
      const { email, password } = payload;
      if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.msg || "Couldn't create user");
      return res.status(200).json({ user: { id: data.id, email: data.email } });
    }

    if (action === "updateEmail") {
      const { id, email } = payload;
      if (!id || !email) return res.status(400).json({ error: "User id and new email are required." });
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ email }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.msg || "Couldn't update email");
      return res.status(200).json({ user: { id: data.id, email: data.email } });
    }

    if (action === "updatePassword") {
      const { id, password } = payload;
      if (!id || !password) return res.status(400).json({ error: "User id and new password are required." });
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.msg || "Couldn't update password");
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      const { id } = payload;
      if (!id) return res.status(400).json({ error: "User id is required." });
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.msg || "Couldn't remove user");
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}