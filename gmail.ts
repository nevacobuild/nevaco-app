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
const CLIENT_ID = (Deno.env.get("GOOGLE_CLIENT_ID") || "").trim();
const CLIENT_SECRET = (Deno.env.get("GOOGLE_CLIENT_SECRET") || "").trim();
const SCOPES = "https://www.googleapis.com/auth/gmail.modify openid email";
const G = "https://gmail.googleapis.com/gmail/v1/users/me";
const LABEL = "NEVACO Partners";
const LOGO = `${APP}/logo-dark.png`;
const BUCKET = "job-files";
const DEFAULT_INBOUND = '(label:realtor-partnership OR label:property-management OR subject:("Referral Sign-Up" OR "Partner Sign-Up" OR "Partnership Opportunity" OR "Renovation Partner for Your Managed Properties"))';

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
// Out-of-office and other automatic replies are not real replies
export function isAutoReply(m: { payload?: Part }) {
  const as = hdr(m, "Auto-Submitted"), pr = hdr(m, "Precedence"), subj = hdr(m, "Subject");
  return (/auto-(replied|generated|notified)/i.test(as)) || !!hdr(m, "X-Autoreply") || !!hdr(m, "X-Autorespond") || /^(auto_reply|bulk|junk|list)$/i.test(pr.trim()) ||
    /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|away from (the )?office|vacation reply|undeliverable|delivery status notification)/i.test(subj);
}
// "Name: Daryl King Phone: 905... Brokerage: ..." sign-up emails
export function parseSignup(t: string) {
  const KEYS = "Name|Full name|Phone|Cell|Mobile|Brokerage|Company|Email|Website|Area|City";
  const grab = (k: string) => { const m = String(t || "").match(new RegExp(`(?:^|\\s)(?:${k})[ \\t]*:[ \\t]*([^\\n]+?)(?=\\s+(?:${KEYS})\\s*:|\\n|$)`, "i")); return m ? m[1].replace(/^['"\s]+|['"\s.]+$/g, "").trim() : ""; };
  const cut = (v: string) => v.replace(/\s*['"]?\s*(sent on behalf|sent from my|thank you|thanks|regards)\b.*$/i, "").replace(/[\s.'"]+$/, "").trim();
  return { name: cut(grab("Name|Full name")), phone: grab("Phone|Cell|Mobile"), company: cut(grab("Brokerage|Company")) };
}
export function msgRow(m: GMsg, owner: string, me = ALLOWED) {
  const own = owner.startsWith("j:") ? { partner_id: null, job_id: owner.slice(2) } : { partner_id: owner.replace(/^p:/, ""), job_id: null };
  const b = bodies(m.payload);
  const text = b.text || htmlToText(b.html) || m.snippet || "";
  const from = parseAddr(hdr(m, "From"));
  const mine = (m.labelIds || []).includes("SENT") || from.email === me;
  return {
    ...own, dir: mine ? "out" : isAutoReply(m) ? "auto" : "in", gmail_id: m.id, thread_id: m.threadId, rfc_id: hdr(m, "Message-ID") || hdr(m, "Message-Id") || null,
    subject: hdr(m, "Subject"), body: stripQuoted(text).slice(0, 20000), from_email: from.email, to_email: addrList(hdr(m, "To")).join(", "),
    attachments: b.att, unread: !mine && !isAutoReply(m) && (m.labelIds || []).includes("UNREAD"),
    at: new Date(Number(m.internalDate) || Date.now()).toISOString(), created_by: "gmail",
  };
}
/* ---------- HomeStars emails ---------- */
export function links(html: string) {
  const out: { href: string; text: string }[] = [];
  for (const m of String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
    out.push({ href: m[1].replace(/&amp;/g, "&"), text: htmlToText(m[2]).replace(/\s+/g, " ").trim() });
  return out;
}
export const fmtPostal = (p: string) => { const c = String(p || "").toUpperCase().replace(/\s+/g, ""); return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(c) ? c.slice(0, 3) + " " + c.slice(3) : String(p || "").toUpperCase(); };
export function hsType(t: string) {
  t = String(t || "").toLowerCase();
  if (/kitchen|countertop|cabinet/.test(t)) return "Kitchen renovation";
  if (/basement/.test(t)) return "Basement renovation";
  if (/bathroom|shower|\bbath\b|vanity|tub/.test(t)) return "Bathroom renovation";
  if (/faucet|toilet|plumb|leak|pipe/.test(t)) return "Plumbing";
  if (/electric|circuit|light|wiring|panel|heat cable/.test(t)) return "Electrical";
  if (/drywall|plaster|framing|partition/.test(t)) return "Drywall / framing";
  if (/floor|tile/.test(t)) return "Flooring";
  if (/paint/.test(t)) return "Painting";
  if (/deck|stair|carpent|door|shed|furniture|trim|millwork/.test(t)) return "Carpentry / millwork";
  if (/commercial|office|gym|retail|restaurant/.test(t)) return "Commercial renovation";
  if (/addition|new building/.test(t)) return "Home addition";
  if (/renovat|general contractor|repairs and upkeep/.test(t)) return "Full home renovation";
  return "Other";
}
// Classify one HomeStars email and pull out what we need
export function parseHomeStars(subject: string, text: string, html: string) {
  const s = String(subject || "").trim(), t = String(text || "");
  const L = links(html);
  const link = (re: RegExp) => (L.find((l) => re.test(l.text)) || { href: "" }).href;
  let m = s.match(/start the conversation for (.+)$/i);
  if (m) {
    const name = (t.match(/(?:^|\n)\s*([^\n]+?), the customer who posted the job/i) || [])[1] || "";
    const loc = t.match(/\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\s*,\s*([^\n]+)/);
    return { kind: "lead" as const, title: m[1].trim(), name: name.trim(), job: (t.match(/Job number:\s*(\d+)/i) || [])[1] || "",
      postal: loc ? fmtPostal(loc[1]) : "", city: loc ? loc[2].trim() : "", fee: (t.match(/Lead fee:\s*\$?([\d,.]+\d)/i) || [])[1] || "",
      url: link(/view contact/i) || link(/contact|conversation|message/i) };
  }
  m = s.match(/^New message about (.+)$/i);
  if (m) {
    const nm = t.match(/(?:^|\n|,)\s*([^\n,]+?) sent you a new message/i);
    let body = (t.split(/sent you a new message/i)[1] || "").split(/Reply to this message|Do not share this email|Please don.t reply/i)[0].trim();
    if (!body) body = "(sent a message on HomeStars)";
    return { kind: "message" as const, title: m[1].trim(), name: nm ? nm[1].trim() : "", body, url: link(/reply|view|message/i) };
  }
  m = s.match(/new invites? in ([A-Z]\d[A-Z]\s?\d[A-Z]\d)/i);
  if (m) {
    const nm = t.match(/(?:^|\n|!)\s*([^\n!.]+?) viewed your profile/i);
    let title = (t.match(/discuss this lead with you\.?\s*\n+\s*([^\n]+)/i) || [])[1] || "";
    if (/^(view|see|accept|reply|open)\b/i.test(title.trim())) title = "";
    return { kind: "invite" as const, title: title.trim(), name: nm ? nm[1].trim() : "", postal: fmtPostal(m[1]), url: link(/invite|view|see|accept/i) };
  }
  m = s.match(/^(.+),\s*([^,]+),\s*(\d+)\s*km\s*$/i);
  if (m && !/new leads in your/i.test(s)) {
    return { kind: "area" as const, title: m[1].trim(), city: m[2].trim(), km: Number(m[3]), hired: /hired on HomeStars before/i.test(t), url: link(/see more details|view lead|see details|view/i) };
  }
  return null;
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
  return { outreach_query: "", inbound_query: DEFAULT_INBOUND, import_days: 90, from_name: "NEVACO BUILD", signature: "", pdf_path: "", pdf_name: "", ...(data?.value || {}) } as Record<string, any>;
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

// Bring new emails into the app: partner conversations, lead/customer emails and HomeStars.
// opts.email: import past emails with one address (used right after adding a partner or a lead).
async function sync(opts: { email?: string; partner_id?: string; job_id?: string; days?: number }) {
  const acc = await account();
  if (!acc) return { connected: false };
  const started = new Date();
  // one sync at a time
  const stale = new Date(Date.now() - 120_000).toISOString();
  const { data: lock } = await db.from("gmail_account").update({ sync_started_at: started.toISOString() }).eq("id", 1)
    .or(`sync_started_at.is.null,sync_started_at.lt."${stale}"`).select("id");
  if (!lock?.length) return { connected: true, busy: true };
  const firstRun = !acc.last_sync_at;
  try {
    const cfg = await settings();
    const days = Number(opts.days || cfg.import_days || 90);
    const since = opts.email ? Date.now() - 400 * 864e5 : acc.last_sync_at ? Date.parse(acc.last_sync_at) - 15 * 60e3 : Date.now() - days * 864e5;
    const after = `after:${Math.floor(since / 1000)}`;

    const { data: partners } = await db.from("partners").select("id,email,name");
    const { data: jobs } = await db.from("jobs").select("id,email,name,source,stage,lost,created_at,ext_ref").order("created_at", { ascending: true });
    // never turn our own addresses (team, test emails) into partners
    const { data: team } = await db.from("team_members").select("email");
    const ignore = new Set<string>([...(team || []).map((t: any) => String(t.email).toLowerCase()), ...((cfg.ignore_emails || []) as string[]).map((e) => String(e).toLowerCase().trim())]);
    const byEmail = new Map<string, string>(); // email -> "p:ID" or "j:ID"
    (jobs || []).forEach((j: any) => { const e = String(j.email || "").toLowerCase().trim(); if (isEmail(e) && !ignore.has(e) && e !== ALLOWED) byEmail.set(e, "j:" + j.id); }); // newest job wins
    (partners || []).forEach((p: any) => { if (p.email) byEmail.set(String(p.email).toLowerCase().trim(), "p:" + p.id); });
    const names = new Map<string, string>([...(partners || []).map((p: any) => ["p:" + p.id, p.name] as [string, string]), ...(jobs || []).map((j: any) => ["j:" + j.id, j.name] as [string, string])]);
    const { data: known } = await db.from("partner_messages").select("gmail_id,thread_id,partner_id,job_id").not("gmail_id", "is", null);
    const knownIds = new Set((known || []).map((k: any) => k.gmail_id).filter(Boolean));
    const byThread = new Map<string, string>();
    (known || []).forEach((k: any) => { if (k.thread_id && k.thread_id !== "homestars") byThread.set(k.thread_id, k.partner_id ? "p:" + k.partner_id : "j:" + k.job_id); });

    const threads = new Set<string>(); const outreach = new Set<string>(); const inbound = new Set<string>();
    const forcedOwner = opts.email ? (opts.partner_id ? "p:" + opts.partner_id : opts.job_id ? "j:" + opts.job_id : "") : "";
    if (opts.email) {
      const e = opts.email.toLowerCase().trim();
      if (!isEmail(e)) throw new HttpError(400, "Not a valid email address.");
      (await listIds(acc, `(from:${e} OR to:${e} OR cc:${e}) -in:spam -in:trash -in:drafts ${after}`, 500)).forEach((m) => { if (!knownIds.has(m.id)) threads.add(m.threadId); });
    } else {
      const q = String(cfg.outreach_query || "").trim();
      if (q) (await listIds(acc, `in:sent ${q} newer_than:400d`, 3000)).forEach((m) => outreach.add(m.threadId));
      // labelled conversations and sign-up emails, even when they are not replies to an outreach email
      const iq = String(cfg.inbound_query || "").trim();
      if (iq) for (const m of await listIds(acc, `-from:me ${iq} -in:spam -in:trash newer_than:400d`, 2000))
        if (!knownIds.has(m.id)) { threads.add(m.threadId); inbound.add(m.threadId); }
      for (const m of await listIds(acc, `${after} -in:spam -in:trash -in:drafts -in:chats -from:homestars.com`, 5000))
        if (!knownIds.has(m.id) && (byThread.has(m.threadId) || outreach.has(m.threadId))) threads.add(m.threadId);
      const emails = [...byEmail.keys()].filter(isEmail);
      for (let i = 0; i < emails.length; i += 30) {
        const grp = emails.slice(i, i + 30).join(" OR ");
        for (const m of await listIds(acc, `${after} (from:(${grp}) OR to:(${grp})) -in:spam -in:trash -in:drafts`, 1000))
          if (!knownIds.has(m.id)) threads.add(m.threadId);
      }
      // a lead's older emails, once, when the lead first gets an email address
      const { data: done } = await db.from("notify_state").select("key").like("key", "jm:%");
      const doneSet = new Set((done || []).map((d: any) => d.key));
      const fresh = (jobs || []).filter((j: any) => isEmail(String(j.email || "").trim()) && !doneSet.has("jm:" + j.id) && !j.lost).slice(-15);
      for (const j of fresh) {
        const e = String(j.email).toLowerCase().trim();
        if (byEmail.get(e) !== "j:" + j.id) continue;
        try { for (const m of await listIds(acc, `(from:${e} OR to:${e}) -in:spam -in:trash -in:drafts newer_than:180d`, 200)) if (!knownIds.has(m.id)) threads.add(m.threadId); } catch { /* next time */ }
      }
      if (fresh.length) await db.from("notify_state").upsert(fresh.map((j: any) => ({ key: "jm:" + j.id, at: new Date().toISOString() })), { onConflict: "key" });
    }

    const rows: any[] = []; const newPartners: string[] = []; const touched = new Set<string>();
    let labelNames: Record<string, string> | null = null;
    const labelType = async (ids: string[]) => {
      if (!labelNames) { labelNames = {}; try { ((await gapi(acc, "/labels")).labels || []).forEach((l: any) => labelNames![l.id] = l.name); } catch { /* optional */ } }
      const n = ids.map((i) => labelNames![i] || "").join(" ");
      return /propert|landlord|manag/i.test(n) ? "pm" : /realt|broker|agent/i.test(n) ? "re" : "";
    };
    const fetched = await pmap([...threads], 5, (t) => gapi(acc, `/threads/${t}?format=full`).catch((e) => { console.warn("thread", t, e.message); return null; }));
    for (const t of fetched) {
      if (!t) continue;
      const msgs: GMsg[] = (t.messages || []).filter((m: GMsg) => !(m.labelIds || []).includes("DRAFT"))
        .sort((a: GMsg, b: GMsg) => Number(a.internalDate) - Number(b.internalDate));
      const mine = (m: GMsg) => (m.labelIds || []).includes("SENT") || parseAddr(hdr(m, "From")).email === ALLOWED;
      let owner = forcedOwner || byThread.get(t.id) || "";
      if (!owner) for (const m of msgs) {
        const other = mine(m) ? [...addrList(hdr(m, "To")), ...addrList(hdr(m, "Cc"))] : [parseAddr(hdr(m, "From")).email];
        const hit = other.find((e) => byEmail.has(e)); if (hit) { owner = byEmail.get(hit)!; break; }
      }
      if (!owner && (outreach.has(t.id) || inbound.has(t.id))) {
        const others = msgs.filter((m) => !mine(m));
        const real = others.find((m) => !isAutoReply(m));
        const reply = real || (inbound.has(t.id) ? others[0] : undefined);
        if (!reply) continue; // sent but nobody replied yet
        const a = parseAddr(hdr(reply, "From"));
        if (!a.email || a.email === ALLOWED || ignore.has(a.email) || /mailer-daemon|postmaster|homestars\.com/i.test(a.email)) continue;
        if (!inbound.has(t.id) && /no-?reply/i.test(a.email)) continue;
        // another sync may have just created this partner
        const { data: ex } = await db.from("partners").select("id").ilike("email", a.email).limit(1);
        if (ex?.length) owner = "p:" + ex[0].id;
        else {
          const first = msgs.find(mine);
          const ctx = `${hdr(first || reply, "Subject")} ${hdr(reply, "Subject")} ${first ? bodies(first.payload).text.slice(0, 2000) : ""}`;
          const rb = bodies(reply.payload); const su = parseSignup(rb.text || htmlToText(rb.html));
          const lt = await labelType(msgs.flatMap((m) => m.labelIds || []));
          const { data: np, error } = await db.from("partners").insert({
            name: su.name || (a.name && !a.name.includes("@") ? a.name : nameFromEmail(a.email)), email: a.email, phone: su.phone, company: su.company || companyFromEmail(a.email),
            type: lt || (/brokerage|realt/i.test(su.company + " " + ctx) && !/managed propert|property\s*manag/i.test(ctx) ? "re" : /property\s*manag|managed propert|landlord|tenant|turnover/i.test(ctx) ? "pm" : "re"),
            status: real ? "replied" : "sent", source: "gmail", updated_by: "gmail",
          }).select("id,name").single();
          if (error) { console.warn("partner insert", error.message); continue; }
          owner = "p:" + np.id; newPartners.push(np.name); names.set(owner, np.name);
        }
        byEmail.set(a.email, owner);
      }
      if (!owner) continue;
      byThread.set(t.id, owner);
      for (const m of msgs) if (!knownIds.has(m.id)) { rows.push(msgRow(m, owner)); knownIds.add(m.id); if (owner.startsWith("p:")) touched.add(t.id); }
    }

    // HomeStars: new leads, messages from customers, invites and leads in your area
    const hs = opts.email ? { leads: [] as string[], messages: 0, invites: [] as string[], area: 0 } : await homeStars(acc, jobs || [], knownIds, rows, firstRun);

    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from("partner_messages").upsert(rows.slice(i, i + 200), { onConflict: "gmail_id", ignoreDuplicates: true });
      if (error) throw new HttpError(500, error.message);
    }
    await labelThreads(acc, [...touched]);
    await db.from("gmail_account").update({ ...(opts.email ? {} : { last_sync_at: started.toISOString() }), last_error: null, sync_started_at: null }).eq("id", 1);

    // push: new replies (not on the very first import)
    const fresh = rows.filter((r) => r.dir === "in" && r.unread && Date.now() - Date.parse(r.at) < 6 * 3600e3);
    if (!firstRun && !opts.email && fresh.length) {
      const who = [...new Set(fresh.map((r) => names.get(r.partner_id ? "p:" + r.partner_id : "j:" + r.job_id) || r.from_email))];
      const one = fresh[fresh.length - 1];
      const url = one.partner_id ? `/?partner=${one.partner_id}` : `/?lead=${one.job_id}`;
      await sendPush(fresh.length > 1 ? `${fresh.length} new replies` : `New reply from ${who[0]}`,
        fresh.length > 1 ? who.slice(0, 4).join(", ") : String(one.body || one.subject || "").replace(/\s+/g, " ").slice(0, 140), url, "reply");
    }
    if (!firstRun && hs.invites.length) await sendPush(`HomeStars invite`, `${hs.invites.join(", ")} wants to talk about a job. Accept it on HomeStars.`, "/?tab=leads&view=opps", "invite");

    return { connected: true, added: rows.length, replies: rows.filter((r) => r.dir === "in").length, newPartners, homestars: hs };
  } catch (e) {
    await db.from("gmail_account").update({ sync_started_at: null, ...(e instanceof HttpError && e.status === 409 ? {} : { last_error: String((e as Error).message || e) }) }).eq("id", 1);
    throw e;
  }
}

async function homeStars(acc: Acc, jobs: any[], knownIds: Set<string>, rows: any[], firstRun: boolean) {
  const out = { leads: [] as string[], messages: 0, invites: [] as string[], area: 0 };
  const { data: st } = await db.from("notify_state").select("at").eq("key", "hs_sync").maybeSingle();
  const since = st?.at ? Date.parse(st.at) - 20 * 60e3 : Date.now() - 21 * 864e5;
  const startedAt = new Date().toISOString();
  const ids = await listIds(acc, `from:homestars.com after:${Math.floor(since / 1000)}`, 400);
  if (!ids.length) { await db.from("notify_state").upsert({ key: "hs_sync", at: startedAt }); return out; }
  const { data: doneOpp } = await db.from("opportunities").select("gmail_id").in("gmail_id", ids.map((m) => m.id));
  const { data: doneHs } = await db.from("notify_state").select("key").in("key", ids.map((m) => "hs:" + m.id));
  const skip = new Set([...(doneOpp || []).map((o: any) => o.gmail_id), ...(doneHs || []).map((d: any) => d.key.slice(3)), ...knownIds]);
  const todo = ids.filter((m) => !skip.has(m.id));
  const full: GMsg[] = (await pmap(todo, 5, (m) => gapi(acc, `/messages/${m.id}?format=full`).catch(() => null))).filter(Boolean) as GMsg[];
  full.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const hsJobs = jobs.filter((j) => j.source === "HomeStars");
  const findJob = (name: string) => { const n = name.toLowerCase().trim(); return [...hsJobs].reverse().find((j) => String(j.name || "").toLowerCase().trim() === n); };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const processed: string[] = [];
  for (const m of full) {
    const b = bodies(m.payload); const text = b.text || htmlToText(b.html);
    const p = parseHomeStars(hdr(m, "Subject"), text, b.html);
    const at = new Date(Number(m.internalDate) || Date.now()).toISOString();
    processed.push(m.id);
    if (!p) continue;
    if (p.kind === "lead") {
      const ref = p.job ? "HS-" + p.job : "";
      let j = ref ? jobs.find((x) => x.ext_ref === ref) : undefined;
      if (!j) {
        const id = p.job ? "hs" + p.job : "hs" + m.id;
        const notes = [`HomeStars job${p.job ? " #" + p.job : ""}: ${p.title}`, p.fee ? `Lead fee: $${p.fee} + tax` : "", p.url ? `Phone and email on HomeStars: ${p.url}` : ""].filter(Boolean).join("\n");
        const row = { id, ext_ref: ref || null, name: p.name || "HomeStars lead", phone: "", email: "", address: "", city: p.city || "", postal: p.postal || "", type: hsType(p.title),
          source: "HomeStars", value: null, hst: true, notes, stage: "lead", ms: {}, history: [{ d: today, t: "New lead from HomeStars", by: "HomeStars" }], updated_by: "homestars" };
        const { error } = await db.from("jobs").upsert(row, { onConflict: "id", ignoreDuplicates: true });
        if (error) { console.warn("hs job", error.message); continue; }
        j = { ...row, created_at: at }; jobs.push(j); hsJobs.push(j); out.leads.push(row.name);
      }
      rows.push({ partner_id: null, job_id: j.id, dir: "in", gmail_id: m.id, thread_id: "homestars", subject: p.title,
        body: `${p.name || "The customer"} wants to get in touch about: ${p.title}${p.url ? "\nOpen HomeStars to see their phone and email." : ""}`,
        from_email: "homestars", to_email: "", attachments: p.url ? [{ name: "Open on HomeStars", url: p.url }] : [], unread: true, at, created_by: "homestars" });
      // the invite / area lead for this person is now taken
      if (p.name) await db.from("opportunities").update({ status: "taken" }).ilike("customer", p.name).eq("status", "new");
      await db.from("opportunities").update({ status: "taken" }).eq("title", p.title).eq("status", "new").ilike("city", p.city || "-");
    } else if (p.kind === "message") {
      const j = p.name ? findJob(p.name) : undefined;
      if (!j) continue;
      rows.push({ partner_id: null, job_id: j.id, dir: "in", gmail_id: m.id, thread_id: "homestars", subject: `HomeStars · ${p.title}`, body: p.body,
        from_email: "homestars", to_email: "", attachments: p.url ? [{ name: "Reply on HomeStars", url: p.url }] : [], unread: true, at, created_by: "homestars" });
      out.messages++;
    } else if (p.kind === "invite") {
      await db.from("opportunities").upsert({ source: "HomeStars", kind: "invite", title: p.title, customer: p.name, postal: p.postal, url: p.url, gmail_id: m.id, at, status: "new" }, { onConflict: "gmail_id", ignoreDuplicates: true });
      if (Date.now() - Date.parse(at) < 6 * 3600e3 && p.name) out.invites.push(p.name);
    } else if (p.kind === "area") {
      await db.from("opportunities").upsert({ source: "HomeStars", kind: "area", title: p.title, city: p.city, km: p.km, hired_before: p.hired, url: p.url, gmail_id: m.id, at, status: "new" }, { onConflict: "gmail_id", ignoreDuplicates: true });
      out.area++;
    }
  }
  if (processed.length) await db.from("notify_state").upsert(processed.map((id) => ({ key: "hs:" + id, at: startedAt })), { onConflict: "key", ignoreDuplicates: true });
  await db.from("notify_state").upsert({ key: "hs_sync", at: startedAt }, { onConflict: "key" });
  // keep the opportunities list short: anything older than 14 days goes away
  await db.from("opportunities").delete().lt("at", new Date(Date.now() - 14 * 864e5).toISOString()).neq("status", "taken");
  if (firstRun) out.invites = [];
  return out;
}

/* ---------- push notifications (Web Push, works on iPhone/iPad home-screen apps and Mac) ---------- */
const concatB = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((t, x) => t + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const fromB64url = (s: string) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "===".slice((s.length + 3) % 4); const b = atob(s); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// RFC 8291 (aes128gcm) payload encryption
export async function encryptPush(payload: Uint8Array, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16)), asKeys?: CryptoKeyPair) {
  const ua = fromB64url(p256dh), authS = fromB64url(auth);
  const as = asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authS, shared, concatB(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concatB(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concatB(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidKeys() {
  const { data } = await db.from("private_config").select("vapid_public,vapid_private").eq("id", 1).maybeSingle();
  if (data?.vapid_public && data?.vapid_private) return { pub: data.vapid_public as string, jwk: JSON.parse(data.vapid_private) };
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  await db.from("private_config").update({ vapid_public: pub, vapid_private: JSON.stringify(jwk) }).eq("id", 1);
  return { pub, jwk };
}
async function vapidAuth(endpoint: string, v: { pub: string; jwk: JsonWebKey }) {
  const aud = new URL(endpoint).origin;
  const h = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:" + ALLOWED })));
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${h}.${c}`)));
  return `vapid t=${h}.${c}.${b64url(sig)}, k=${v.pub}`;
}
async function sendPush(title: string, body: string, url = "/", tag = "nevaco") {
  const { data: subs } = await db.from("push_subs").select("*");
  if (!subs?.length) return { sent: 0 };
  const v = await vapidKeys();
  const payload = enc.encode(JSON.stringify({ title, body, url, tag }));
  let sent = 0;
  await pmap(subs, 4, async (s: any) => {
    try {
      const r = await fetch(s.endpoint, { method: "POST", body: await encryptPush(payload, s.p256dh, s.auth),
        headers: { Authorization: await vapidAuth(s.endpoint, v), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" } });
      if (r.status === 404 || r.status === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      else if (r.ok) { sent++; await db.from("push_subs").update({ last_ok: new Date().toISOString() }).eq("endpoint", s.endpoint); }
      else console.warn("push", r.status, await r.text().catch(() => ""));
    } catch (e) { console.warn("push", (e as Error).message); }
  });
  return { sent };
}
async function pushSubscribe(user: string, b: any) {
  const s = b.subscription || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError(400, "Notifications could not be turned on.");
  await db.from("push_subs").upsert({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, email: user, device: String(b.device || "").slice(0, 80) }, { onConflict: "endpoint" });
  if (b.test !== false) await sendPush("Notifications are on", "You'll hear about new leads and replies here.", "/", "welcome");
  return { ok: true };
}
const LEADS_TAB: Record<string, string> = { "Website form": "website", "HomeStars": "homestars", "Facebook": "facebook", "Instagram": "instagram", "Instagram / Facebook ad": "facebook" };
async function notifyJob(id: string) {
  const { data: j } = await db.from("jobs").select("id,name,type,city,source,updated_by").eq("id", id).maybeSingle();
  if (!j || String(j.updated_by || "").includes("@")) return { skipped: true };
  return sendPush(`New lead · ${j.source || "Lead"}`, [j.name, j.type, j.city].filter(Boolean).join(" · "), `/?lead=${j.id}`, "lead-" + j.id);
}
// Hourly: nudge about leads and replies that are waiting on you (8 AM to 8 PM Toronto time)
async function remind() {
  const hour = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hour12: false }).format(new Date())) % 24;
  if (hour < 8 || hour >= 20) return { skipped: "night" };
  const { data: jobs } = await db.from("jobs").select("id,name,source,ms,lost,stage,created_at").eq("lost", false).in("stage", ["lead", "visit", "quote"]);
  const { data: msgs } = await db.from("partner_messages").select("partner_id,job_id,dir,at").in("dir", ["in", "out"]).gte("at", new Date(Date.now() - 30 * 864e5).toISOString()).order("at");
  const { data: partners } = await db.from("partners").select("id,name,status");
  const last = new Map<string, any>();
  (msgs || []).forEach((m: any) => last.set(m.partner_id ? "p:" + m.partner_id : "j:" + m.job_id, m));
  const waiting: { key: string; label: string }[] = [];
  const now = Date.now();
  for (const j of jobs || []) {
    const lm = last.get("j:" + j.id);
    if (lm && lm.dir === "in" && now - Date.parse(lm.at) > 2 * 3600e3) waiting.push({ key: "j:" + j.id, label: `${j.name} (${j.source || "lead"})` });
    else if (!lm && !(j.ms || {}).contacted?.done && j.stage === "lead" && now - Date.parse(j.created_at) > 3600e3 && now - Date.parse(j.created_at) < 14 * 864e5)
      waiting.push({ key: "j:" + j.id, label: `${j.name} (${j.source || "lead"}) · not contacted` });
  }
  for (const p of partners || []) {
    const lm = last.get("p:" + p.id);
    if (p.status !== "cold" && lm && lm.dir === "in" && now - Date.parse(lm.at) > 3 * 3600e3) waiting.push({ key: "p:" + p.id, label: `${p.name} (partner)` });
  }
  if (!waiting.length) return { waiting: 0 };
  const { data: st } = await db.from("notify_state").select("key,at").in("key", waiting.map((w) => "rem:" + w.key));
  const recent = new Set((st || []).filter((x: any) => now - Date.parse(x.at) < 4 * 3600e3).map((x: any) => x.key.slice(4)));
  const due = waiting.filter((w) => !recent.has(w.key));
  if (!due.length) return { waiting: waiting.length, sent: 0 };
  await sendPush(waiting.length > 1 ? `${waiting.length} leads are waiting for you` : "A lead is waiting for you", waiting.slice(0, 4).map((w) => w.label).join(", ") + (waiting.length > 4 ? "…" : ""), "/?tab=leads&view=reply", "remind");
  await db.from("notify_state").upsert(due.map((w) => ({ key: "rem:" + w.key, at: new Date().toISOString() })), { onConflict: "key" });
  return { waiting: waiting.length, sent: due.length };
}

async function send(user: string, b: any) {
  const acc = await account();
  if (!acc) throw new HttpError(409, "Connect Gmail first.");
  const cfg = await settings();
  const isJob = !!b.job_id;
  const { data: p } = isJob ? await db.from("jobs").select("id,name,email").eq("id", String(b.job_id)).maybeSingle()
    : await db.from("partners").select("*").eq("id", String(b.partner_id || "")).maybeSingle();
  if (!p) throw new HttpError(404, isJob ? "Customer not found." : "Partner not found.");
  const ownCol = isJob ? "job_id" : "partner_id";
  const to = String(b.to || p.email || "").trim().toLowerCase();
  if (!isEmail(to)) throw new HttpError(400, `Add a valid email for ${p.name || "this contact"} first.`);
  const body = String(b.body || "").trim();
  if (!body) throw new HttpError(400, "Write a message first.");
  const subject = clean(b.subject) || "NEVACO BUILD";

  // continue the conversation when the subject matches the last email
  let threadId: string | null = null, inReplyTo: string | null = null, references: string | null = null;
  const { data: prev } = await db.from("partner_messages").select("thread_id,rfc_id,subject,at").eq(ownCol, p.id).neq("dir", "note")
    .not("thread_id", "is", null).neq("thread_id", "homestars").order("at", { ascending: false }).limit(40);
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
  const row = { partner_id: isJob ? null : p.id, job_id: isJob ? p.id : null, dir: "out", gmail_id: sent.id, thread_id: sent.threadId, rfc_id: rfc, subject, body, from_email: acc.email, to_email: to,
    attachments: attachments.map((a) => ({ name: a.name, size: a.bytes.length, mime: a.mime })), unread: false, at: new Date().toISOString(), created_by: user };
  const { data: saved, error } = await db.from("partner_messages").upsert(row, { onConflict: "gmail_id" }).select("*").single();
  if (error) console.warn("save sent", error.message);
  if (!isJob) await labelThreads(acc, [sent.threadId]);
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
    if (cron) {
      await checkCron(cron);
      if (body.action === "notify_job") return json(await notifyJob(String(body.id || "")));
      if (body.action === "remind") return json(await remind());
      return json(await sync({}));
    }
    const user = await teamUser(req);
    switch (body.action) {
      case "start": return json(await start(user));
      case "sync": return json(await sync({ email: body.email, partner_id: body.partner_id, job_id: body.job_id, days: body.days }));
      case "vapid": return json({ key: (await vapidKeys()).pub });
      case "push_sub": return json(await pushSubscribe(user, body));
      case "push_unsub": await db.from("push_subs").delete().eq("endpoint", String(body.endpoint || "")); return json({ ok: true });
      case "push_test": return json(await sendPush("Test notification", "Notifications from NEVACO Job Map are working.", "/", "test"));
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
