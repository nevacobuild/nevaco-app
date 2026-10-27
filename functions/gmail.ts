// NEVACO Job Map: Gmail for Partners (Supabase Edge Function "gmail", Verify JWT = OFF)
// - Connect nevacobuild@gmail.com once (Google sign-in)
// - Send emails to partners from the app (threaded replies, partnership PDF, signature)
// - Bring partner replies into the app (every 2 minutes from pg_cron, and on demand)
// Secrets needed: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
import { createClient } from "npm:@supabase/supabase-js@2";

const APP = "https://app.nevacobuild.ca";
const PROJECT_URL = "https://pnomirvkekhurtuigxol.supabase.co";
const REDIRECT = `${PROJECT_URL}/functions/v1/gmail/callback`;
const ALLOWED = (Deno.env.get("GMAIL_ADDRESS") || "nevacobuild@gmail.com").toLowerCase();
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const SCOPES = "https://www.googleapis.com/auth/gmail.modify openid email";
const G = "https://gmail.googleapis.com/gmail/v1/users/me";
const LABEL = "NEVACO Partners";
const LOGO = `${APP}/logo-dark.png`;
const BUCKET = "job-files";

function serviceKey() {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try { const o = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return o.default || Object.values(o)[0] || ""; } catch { return ""; }
}
const db = createClient(Deno.env.get("SUPABASE_URL") || PROJECT_URL, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* ================= pure helpers (mail format) ================= */
export const enc = new TextEncoder();
export function b64(bytes: Uint8Array) {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
export const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function b64dec(s: string) {
  s = (s || "").replace(/-/g, "+").replace(/_/g, "/"); s += "===".slice((s.length + 3) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
// RFC 2047 for headers that may contain non-ASCII text
export const encWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(enc.encode(s))}?=`;
export const encName = (name: string, email: string) => {
  const n = (name || "").replace(/[\r\n"]/g, "").trim();
  if (!n) return `<${email}>`;
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${email}>` : `${encWord(n)} <${email}>`;
};
const clean = (s: string) => String(s || "").replace(/[\r\n]+/g, " ").trim();
export const escHtml = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export const normSubj = (s: string) => String(s || "").replace(/^\s*((re|fwd?|fw|aw)\s*:\s*)+/i, "").trim().toLowerCase();
export const isEmail = (s: string) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(s);

export function parseAddr(h: string) {
  const m = String(h || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const e = (String(h || "").match(/[^\s<>,;"]+@[^\s<>,;"]+/) || [""])[0].toLowerCase();
  return { name: "", email: e };
}
export const addrList = (h: string) => (String(h || "").match(/[^\s<>,;"':()]+@[^\s<>,;"':()]+\.[a-z]{2,}/gi) || []).map((x) => x.toLowerCase());
export function nameFromEmail(e: string) {
  const local = e.split("@")[0].replace(/[0-9]+/g, " ").replace(/[._-]+/g, " ").trim();
  return local ? local.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : e;
}
const FREE = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|rogers|bell|sympatico|shaw|telus|cogeco|proton|protonmail|gmx)\./i;
export function companyFromEmail(e: string) {
  const d = (e.split("@")[1] || "").toLowerCase();
  return !d || FREE.test(d) ? "" : d;
}

// The signature: first line bold, logo on the left
export function signatureHtml(sig: string) {
  const lines = String(sig || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const txt = lines.map((l, i) => i === 0 ? `<b style="font-size:14px;color:#1d1d1f">${escHtml(l)}</b>` : `<span style="color:#6e6e73">${escHtml(l)}</span>`).join("<br>");
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.45">
<tr><td style="padding-right:14px;border-right:2px solid #e8e8ed;vertical-align:middle"><img src="${LOGO}" width="104" height="45" alt="NEVACO BUILD" style="display:block;border:0"></td>
<td style="padding-left:14px;vertical-align:middle">${txt}</td></tr></table>`;
}
export function bodyHtml(body: string, sig: string) {
  const paras = escHtml(body).replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`).join("");
  return `<!doctype html><html><body style="margin:0"><div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1d1d1f">${paras}${signatureHtml(sig)}</div></body></html>`;
}

export type Attach = { name: string; mime: string; bytes: Uint8Array };
export function buildMime(o: { fromName: string; from: string; toName: string; to: string; subject: string; body: string; signature: string;
  inReplyTo?: string | null; references?: string | null; attachments?: Attach[]; date?: Date; boundary?: string }) {
  const B = o.boundary || ("nb" + crypto.randomUUID().replace(/-/g, ""));
  const plain = o.body.replace(/\r?\n/g, "\r\n") + (o.signature ? "\r\n\r\n" + o.signature.replace(/\r?\n/g, "\r\n") : "");
  const html = bodyHtml(o.body, o.signature);
  const H: string[] = [
    `From: ${encName(o.fromName, o.from)}`,
    `To: ${encName(clean(o.toName), o.to)}`,
    `Subject: ${encWord(clean(o.subject))}`,
    `Date: ${(o.date || new Date()).toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
  ];
  if (o.inReplyTo) H.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) H.push(`References: ${o.references}`);
  const alt = [
    `--${B}a`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(enc.encode(plain))),
    `--${B}a`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(enc.encode(html))),
    `--${B}a--`, "",
  ].join("\r\n");
  const atts = o.attachments || [];
  if (!atts.length) return [...H, `Content-Type: multipart/alternative; boundary="${B}a"`, "", alt].join("\r\n");
  const parts = [`--${B}`, `Content-Type: multipart/alternative; boundary="${B}a"`, "", alt];
  for (const a of atts) {
    const fn = encWord(a.name.replace(/["\r\n]/g, ""));
    parts.push(`--${B}`, `Content-Type: ${a.mime}; name="${fn}"`, `Content-Disposition: attachment; filename="${fn}"`, "Content-Transfer-Encoding: base64", "", wrap76(b64(a.bytes)));
  }
  parts.push(`--${B}--`, "");
  return [...H, `Content-Type: multipart/mixed; boundary="${B}"`, "", ...parts].join("\r\n");
}

type Part = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
export type GMsg = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: Part };
export const hdr = (m: { payload?: Part }, n: string) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
const phdr = (p: Part, n: string) => (p.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
export function bodies(p: Part | undefined, out = { text: "", html: "", att: [] as { name: string; size: number; mime: string }[] }) {
  if (!p) return out;
  const mt = (p.mimeType || "").toLowerCase();
  const inlineImg = mt.startsWith("image/") && /inline/i.test(phdr(p, "Content-Disposition") || "inline") && !!phdr(p, "Content-ID");
  if (p.filename && !inlineImg) out.att.push({ name: p.filename, size: p.body?.size || 0, mime: mt });
  else if (!p.filename && mt === "text/plain" && p.body?.data && !out.text) out.text = b64dec(p.body.data);
  else if (!p.filename && mt === "text/html" && p.body?.data && !out.html) out.html = b64dec(p.body.data);
  (p.parts || []).forEach((c) => bodies(c, out));
  return out;
}
export function htmlToText(h: string) {
  h = String(h || "").split(/<div[^>]*class=["']?[^"'>]*gmail_quote/i)[0].split(/<blockquote/i)[0].split(/<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)/i)[0];
  return h.replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
// Keep only the new part of a reply (drop "On ... wrote:" and quoted history)
export function stripQuoted(t: string) {
  const lines = String(t || "").replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim(), nx = (lines[i + 1] || "").trim();
    const rest = lines.slice(i);
    if (/^On\b.{0,200}\bwrote:?$/i.test(l) || /^Le\b.{0,200}\ba écrit\s*:?$/i.test(l) ||
      (/^On\b/i.test(l) && /^.{0,120}wrote:?$/i.test(nx) && !/wrote:?$/i.test(l)) ||
      /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l) || /^_{10,}$/.test(l) ||
      (/^From:\s/i.test(l) && lines.slice(i + 1, i + 6).some((x) => /^(Sent|Date|To|Subject):\s/i.test(x.trim()))) ||
      (/^>/.test(l) && rest.every((x) => !x.trim() || /^>/.test(x.trim())))) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || String(t || "").trim();
}
export function msgRow(m: GMsg, partnerId: string, me = ALLOWED) {
  const b = bodies(m.payload);
  const text = b.text || htmlToText(b.html) || m.snippet || "";
  const from = parseAddr(hdr(m, "From"));
  const mine = (m.labelIds || []).includes("SENT") || from.email === me;
  return {
    partner_id: partnerId, dir: mine ? "out" : "in", gmail_id: m.id, thread_id: m.threadId, rfc_id: hdr(m, "Message-ID") || hdr(m, "Message-Id") || null,
    subject: hdr(m, "Subject"), body: stripQuoted(text).slice(0, 20000), from_email: from.email, to_email: addrList(hdr(m, "To")).join(", "),
    attachments: b.att, unread: !mine && (m.labelIds || []).includes("UNREAD"),
    at: new Date(Number(m.internalDate) || Date.now()).toISOString(), created_by: "gmail",
  };
}
async function pmap<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/* ================= Google ================= */
type Acc = { email: string; refresh_token: string; access_token?: string; expires_at?: string; label_id?: string; last_sync_at?: string };
async function account(): Promise<Acc | null> {
  const { data } = await db.from("gmail_account").select("*").eq("id", 1).maybeSingle();
  return data?.refresh_token ? data : null;
}
async function tokenCall(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }) });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
}
async function accessToken(acc: Acc) {
  if (acc.access_token && acc.expires_at && Date.parse(acc.expires_at) > Date.now() + 90_000) return acc.access_token;
  const { ok, j } = await tokenCall({ refresh_token: acc.refresh_token, grant_type: "refresh_token" });
  if (!ok) {
    const gone = j.error === "invalid_grant";
    const msg = gone ? "Gmail access was removed or expired. Connect Gmail again." : (j.error_description || j.error || "Google token error");
    await db.from("gmail_account").update({ last_error: msg, ...(gone ? { refresh_token: null, access_token: null } : {}) }).eq("id", 1);
    throw new HttpError(gone ? 409 : 502, msg);
  }
  acc.access_token = j.access_token; acc.expires_at = new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
  await db.from("gmail_account").update({ access_token: acc.access_token, expires_at: acc.expires_at }).eq("id", 1);
  return acc.access_token!;
}
async function gapi(acc: Acc, path: string, init: RequestInit = {}, tries = 3): Promise<any> {
  const tok = await accessToken(acc);
  const headers: Record<string, string> = { Authorization: `Bearer ${tok}` };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const r = await fetch(path.startsWith("http") ? path : G + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  if ((r.status === 429 || r.status >= 500) && tries > 1) { await new Promise((s) => setTimeout(s, 900 * (4 - tries))); return gapi(acc, path, init, tries - 1); }
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : r.status >= 500 ? 502 : 400, j.error?.message || `Gmail error ${r.status}`);
  return j;
}
async function listIds(acc: Acc, q: string, cap = 3000) {
  const out: { id: string; threadId: string }[] = []; let page = "";
  do {
    const u = `/messages?maxResults=500&q=${encodeURIComponent(q)}${page ? "&pageToken=" + page : ""}`;
    const j = await gapi(acc, u); (j.messages || []).forEach((m: any) => out.push(m)); page = j.nextPageToken || "";
  } while (page && out.length < cap);
  return out;
}
async function labelId(acc: Acc) {
  if (acc.label_id) return acc.label_id;
  const l = await gapi(acc, "/labels");
  let lab = (l.labels || []).find((x: any) => x.name === LABEL);
  if (!lab) lab = await gapi(acc, "/labels", { method: "POST", body: JSON.stringify({ name: LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
  acc.label_id = lab.id; await db.from("gmail_account").update({ label_id: lab.id }).eq("id", 1);
  return lab.id as string;
}
async function labelThreads(acc: Acc, tids: string[]) {
  if (!tids.length) return;
  try { const id = await labelId(acc); await pmap(tids, 4, (t) => gapi(acc, `/threads/${t}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [id] }) }).catch(() => null)); }
  catch (e) { console.warn("label", e); }
}
async function settings() {
  const { data } = await db.from("app_settings").select("value").eq("key", "partners").maybeSingle();
  return { outreach_query: "", import_days: 90, from_name: "NEVACO BUILD", signature: "", pdf_path: "", pdf_name: "", ...(data?.value || {}) } as Record<string, any>;
}

/* ================= actions ================= */
async function teamUser(req: Request) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) throw new HttpError(401, "Please sign in again.");
  const { data, error } = await db.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) throw new HttpError(401, "Please sign in again.");
  const { data: team } = await db.from("team_members").select("email");
  if (!(team || []).some((t: any) => String(t.email).toLowerCase() === email)) throw new HttpError(403, "This account is not on the NEVACO team.");
  return email;
}
async function start(user: string) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new HttpError(500, "Google sign-in is not set up yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing).");
  const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await db.from("gmail_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600e3).toISOString());
  const { error } = await db.from("gmail_oauth_states").insert({ state, email: user });
  if (error) throw new HttpError(500, error.message);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent",
    include_granted_scopes: "true", login_hint: ALLOWED, state }).forEach(([k, v]) => u.searchParams.set(k, v));
  return { url: u.toString() };
}
async function callback(url: URL) {
  const back = (q: Record<string, string>) => new Response(null, { status: 302, headers: { Location: `${APP}/?${new URLSearchParams(q)}#partners` } });
  const err = url.searchParams.get("error");
  if (err) return back({ gmail: "error", msg: err === "access_denied" ? "Gmail access was not allowed." : err });
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  const { data: st } = await db.from("gmail_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || Date.now() - Date.parse(st.created_at) > 3600e3) return back({ gmail: "error", msg: "This sign-in link expired. Tap Connect Gmail again." });
  await db.from("gmail_oauth_states").delete().eq("state", state);
  const { ok, j } = await tokenCall({ code, redirect_uri: REDIRECT, grant_type: "authorization_code" });
  if (!ok) return back({ gmail: "error", msg: j.error_description || j.error || "Google sign-in failed." });
  if (!String(j.scope || "").includes("gmail.modify")) {
    await revoke(j.refresh_token || j.access_token);
    return back({ gmail: "error", msg: "Please tick the box that lets NEVACO read, compose and send email, then try again." });
  }
  if (!j.refresh_token) return back({ gmail: "error", msg: "Google did not give lasting access. Tap Connect Gmail again." });
  const pr = await fetch(G + "/profile", { headers: { Authorization: `Bearer ${j.access_token}` } });
  const p = await pr.json().catch(() => ({}));
  const email = String(p.emailAddress || "").toLowerCase();
  if (email !== ALLOWED) {
    await revoke(j.refresh_token);
    return back({ gmail: "error", msg: `Please choose ${ALLOWED}${email ? ` (you chose ${email})` : ""}.` });
  }
  const { error } = await db.from("gmail_account").upsert({ id: 1, email, refresh_token: j.refresh_token, access_token: j.access_token,
    expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), connected_at: new Date().toISOString(),
    last_error: null, last_sync_at: null, sync_started_at: null, label_id: null });
  if (error) return back({ gmail: "error", msg: error.message });
  return back({ gmail: "connected" });
}
async function revoke(tok?: string) {
  if (tok) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(tok), { method: "POST" }).catch(() => null);
}
async function disconnect() {
  const { data } = await db.from("gmail_account").select("refresh_token").eq("id", 1).maybeSingle();
  await revoke(data?.refresh_token);
  await db.from("gmail_account").delete().eq("id", 1);
  return { connected: false };
}

// Bring new partner emails into the app.
// opts.email: import past emails with one address (used right after adding a partner).
async function sync(opts: { email?: string; partner_id?: string; days?: number }) {
  const acc = await account();
  if (!acc) return { connected: false };
  const started = new Date();
  // one sync at a time
  const stale = new Date(Date.now() - 120_000).toISOString();
  const { data: lock } = await db.from("gmail_account").update({ sync_started_at: started.toISOString() }).eq("id", 1)
    .or(`sync_started_at.is.null,sync_started_at.lt."${stale}"`).select("id");
  if (!lock?.length) return { connected: true, busy: true };
  try {
    const cfg = await settings();
    const days = Number(opts.days || cfg.import_days || 90);
    const since = opts.email ? Date.now() - 400 * 864e5 : acc.last_sync_at ? Date.parse(acc.last_sync_at) - 15 * 60e3 : Date.now() - days * 864e5;
    const after = `after:${Math.floor(since / 1000)}`;

    const { data: partners } = await db.from("partners").select("id,email,name");
    const byEmail = new Map<string, string>();
    (partners || []).forEach((p: any) => { if (p.email) byEmail.set(String(p.email).toLowerCase().trim(), p.id); });
    const { data: known } = await db.from("partner_messages").select("gmail_id,thread_id,partner_id").not("thread_id", "is", null);
    const knownIds = new Set((known || []).map((k: any) => k.gmail_id).filter(Boolean));
    const byThread = new Map<string, string>((known || []).map((k: any) => [k.thread_id, k.partner_id]));

    const threads = new Set<string>(); const outreach = new Set<string>();
    if (opts.email) {
      const e = opts.email.toLowerCase().trim();
      if (!isEmail(e)) throw new HttpError(400, "Not a valid email address.");
      (await listIds(acc, `(from:${e} OR to:${e} OR cc:${e}) -in:spam -in:trash -in:drafts ${after}`, 500)).forEach((m) => { if (!knownIds.has(m.id)) threads.add(m.threadId); });
    } else {
      const q = String(cfg.outreach_query || "").trim();
      if (q) (await listIds(acc, `in:sent ${q} newer_than:400d`, 3000)).forEach((m) => outreach.add(m.threadId));
      for (const m of await listIds(acc, `${after} -in:spam -in:trash -in:drafts -in:chats`, 5000))
        if (!knownIds.has(m.id) && (byThread.has(m.threadId) || outreach.has(m.threadId))) threads.add(m.threadId);
      const emails = [...byEmail.keys()].filter(isEmail);
      for (let i = 0; i < emails.length; i += 30) {
        const grp = emails.slice(i, i + 30).join(" OR ");
        for (const m of await listIds(acc, `${after} (from:(${grp}) OR to:(${grp})) -in:spam -in:trash -in:drafts`, 1000))
          if (!knownIds.has(m.id)) threads.add(m.threadId);
      }
    }

    const rows: any[] = []; const newPartners: string[] = []; const touched = new Set<string>();
    const fetched = await pmap([...threads], 5, (t) => gapi(acc, `/threads/${t}?format=full`).catch((e) => { console.warn("thread", t, e.message); return null; }));
    for (const t of fetched) {
      if (!t) continue;
      const msgs: GMsg[] = (t.messages || []).filter((m: GMsg) => !(m.labelIds || []).includes("DRAFT"))
        .sort((a: GMsg, b: GMsg) => Number(a.internalDate) - Number(b.internalDate));
      const mine = (m: GMsg) => (m.labelIds || []).includes("SENT") || parseAddr(hdr(m, "From")).email === ALLOWED;
      let pid = opts.partner_id && opts.email ? opts.partner_id : byThread.get(t.id);
      if (!pid) for (const m of msgs) {
        const other = mine(m) ? [...addrList(hdr(m, "To")), ...addrList(hdr(m, "Cc"))] : [parseAddr(hdr(m, "From")).email];
        const hit = other.find((e) => byEmail.has(e)); if (hit) { pid = byEmail.get(hit); break; }
      }
      if (!pid && outreach.has(t.id)) {
        const reply = msgs.find((m) => !mine(m));
        if (!reply) continue; // sent but nobody replied yet
        const a = parseAddr(hdr(reply, "From"));
        if (!a.email || a.email === ALLOWED || /no-?reply|mailer-daemon|postmaster/i.test(a.email)) continue;
        // another sync may have just created this partner
        const { data: ex } = await db.from("partners").select("id").ilike("email", a.email).limit(1);
        if (ex?.length) pid = ex[0].id;
        else {
          const first = msgs.find(mine);
          const ctx = `${hdr(first || reply, "Subject")} ${first ? bodies(first.payload).text.slice(0, 2000) : ""}`;
          const { data: np, error } = await db.from("partners").insert({
            name: a.name && !a.name.includes("@") ? a.name : nameFromEmail(a.email), email: a.email, company: companyFromEmail(a.email),
            type: /property\s*manag|landlord|tenant|turnover/i.test(ctx) ? "pm" : "re", status: "replied", source: "gmail", updated_by: "gmail",
          }).select("id,name").single();
          if (error) { console.warn("partner insert", error.message); continue; }
          pid = np.id; newPartners.push(np.name);
        }
        byEmail.set(a.email, pid!);
      }
      if (!pid) continue;
      byThread.set(t.id, pid);
      for (const m of msgs) if (!knownIds.has(m.id)) { rows.push(msgRow(m, pid)); knownIds.add(m.id); touched.add(t.id); }
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from("partner_messages").upsert(rows.slice(i, i + 200), { onConflict: "gmail_id", ignoreDuplicates: true });
      if (error) throw new HttpError(500, error.message);
    }
    await labelThreads(acc, [...touched]);
    await db.from("gmail_account").update({ ...(opts.email ? {} : { last_sync_at: started.toISOString() }), last_error: null, sync_started_at: null }).eq("id", 1);
    return { connected: true, added: rows.length, replies: rows.filter((r) => r.dir === "in").length, newPartners };
  } catch (e) {
    await db.from("gmail_account").update({ sync_started_at: null, ...(e instanceof HttpError && e.status === 409 ? {} : { last_error: String((e as Error).message || e) }) }).eq("id", 1);
    throw e;
  }
}

async function send(user: string, b: any) {
  const acc = await account();
  if (!acc) throw new HttpError(409, "Connect Gmail first.");
  const cfg = await settings();
  const { data: p } = await db.from("partners").select("*").eq("id", String(b.partner_id || "")).maybeSingle();
  if (!p) throw new HttpError(404, "Partner not found.");
  const to = String(b.to || p.email || "").trim().toLowerCase();
  if (!isEmail(to)) throw new HttpError(400, `Add a valid email for ${p.name || "this partner"} first.`);
  const body = String(b.body || "").trim();
  if (!body) throw new HttpError(400, "Write a message first.");
  const subject = clean(b.subject) || "NEVACO BUILD";

  // continue the conversation when the subject matches the last email
  let threadId: string | null = null, inReplyTo: string | null = null, references: string | null = null;
  const { data: prev } = await db.from("partner_messages").select("thread_id,rfc_id,subject,at").eq("partner_id", p.id).neq("dir", "note")
    .not("thread_id", "is", null).order("at", { ascending: false }).limit(40);
  const same = (prev || []).find((m: any) => normSubj(m.subject) === normSubj(subject));
  if (same) {
    threadId = same.thread_id;
    const chain = (prev || []).filter((m: any) => m.thread_id === threadId && m.rfc_id).reverse().map((m: any) => m.rfc_id);
    inReplyTo = chain[chain.length - 1] || null; references = chain.slice(-10).join(" ") || null;
  }

  const attachments: Attach[] = [];
  if (b.attach_pdf) {
    if (!cfg.pdf_path) throw new HttpError(400, "Upload the partnership PDF in Partners settings first.");
    const { data: f, error } = await db.storage.from(BUCKET).download(cfg.pdf_path);
    if (error || !f) throw new HttpError(400, "Could not open the partnership PDF. Upload it again in Partners settings.");
    attachments.push({ name: cfg.pdf_name || "NEVACO BUILD Partnership.pdf", mime: "application/pdf", bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  const signature = b.signature === false ? "" : String(cfg.signature || "");
  const raw = buildMime({ fromName: cfg.from_name || "NEVACO BUILD", from: acc.email, toName: p.name, to, subject, body, signature, inReplyTo, references, attachments });

  let sent: any;
  if (raw.length < 4_500_000) {
    sent = await gapi(acc, "/messages/send", { method: "POST", body: JSON.stringify({ raw: b64url(enc.encode(raw)), ...(threadId ? { threadId } : {}) }) });
  } else {
    const B = "up" + crypto.randomUUID().replace(/-/g, "");
    const multi = `--${B}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${B}\r\nContent-Type: message/rfc822\r\n\r\n${raw}\r\n--${B}--`;
    sent = await gapi(acc, "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
      { method: "POST", body: enc.encode(multi), headers: { "Content-Type": `multipart/related; boundary=${B}` } });
  }
  let rfc: string | null = null;
  try { const meta = await gapi(acc, `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`); rfc = hdr(meta, "Message-ID") || null; } catch { /* not needed to succeed */ }
  const row = { partner_id: p.id, dir: "out", gmail_id: sent.id, thread_id: sent.threadId, rfc_id: rfc, subject, body, from_email: acc.email, to_email: to,
    attachments: attachments.map((a) => ({ name: a.name, size: a.bytes.length, mime: a.mime })), unread: false, at: new Date().toISOString(), created_by: user };
  const { data: saved, error } = await db.from("partner_messages").upsert(row, { onConflict: "gmail_id" }).select("*").single();
  if (error) console.warn("save sent", error.message);
  await labelThreads(acc, [sent.threadId]);
  return { ok: true, message: saved || row };
}

async function markRead(b: any) {
  const ids = (Array.isArray(b.gmail_ids) ? b.gmail_ids : []).filter((x: unknown) => typeof x === "string").slice(0, 500);
  await db.from("partner_messages").update({ unread: false }).in("gmail_id", ids);
  const acc = await account();
  if (acc && ids.length) await gapi(acc, "/messages/batchModify", { method: "POST", body: JSON.stringify({ ids, removeLabelIds: ["UNREAD"] }) }).catch(() => null);
  return { ok: true };
}

// "Test" in settings: how many outreach emails does this search find?
async function preview(b: any) {
  const acc = await account();
  if (!acc) throw new HttpError(409, "Connect Gmail first.");
  const q = String(b.query || "").trim();
  if (!q) return { count: 0, threads: 0, sample: [] };
  const ids = await listIds(acc, `in:sent ${q} newer_than:400d`, 3000);
  const th = [...new Set(ids.map((m) => m.threadId))];
  const sample = await pmap(ids.slice(0, 6), 6, async (m) => {
    const x = await gapi(acc, `/messages/${m.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`).catch(() => null);
    return x ? { to: hdr(x, "To"), subject: hdr(x, "Subject") } : null;
  });
  return { count: ids.length, threads: th.length, sample: sample.filter(Boolean) };
}

async function checkCron(secret: string) {
  const { data } = await db.from("private_config").select("cron_secret").eq("id", 1).maybeSingle();
  if (!data?.cron_secret || data.cron_secret !== secret) throw new HttpError(401, "Bad cron secret");
}

if (typeof Deno !== "undefined" && (Deno as any).serve && !(globalThis as any).__NO_SERVE__) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname.endsWith("/callback")) return await callback(url);
    if (req.method === "GET") return json({ ok: true, service: "nevaco-gmail" });
    const body = await req.json().catch(() => ({}));
    const cron = req.headers.get("x-cron-secret");
    if (cron) { await checkCron(cron); return json(await sync({})); }
    const user = await teamUser(req);
    switch (body.action) {
      case "start": return json(await start(user));
      case "sync": return json(await sync({ email: body.email, partner_id: body.partner_id, days: body.days }));
      case "send": return json(await send(user, body));
      case "read": return json(await markRead(body));
      case "preview": return json(await preview(body));
      case "disconnect": return json(await disconnect());
    }
    throw new HttpError(400, "Unknown action");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    return json({ error: String((e as Error).message || e) }, status);
  }
});
