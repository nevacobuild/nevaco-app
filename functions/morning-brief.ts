// NEVACO Job Map: morning brief email (Supabase Edge Function "morning-brief")
// Sends one email at 7 AM Toronto time with today's work. Called by pg_cron.
import { createClient } from "npm:@supabase/supabase-js@2";

const TO = "nevacobuild@gmail.com";
const APP = "https://app.nevacobuild.ca";
const TZ = "America/Toronto";

type Job = any;
const STEPS = ["contacted", "visit", "estimate", "contract", "deposit", "start", "complete", "final", "review"];

const torontoNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
};
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diff = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
const money = (v: number) => "$" + Math.round(v).toLocaleString("en-CA");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (t: string) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const fmtDate = (d: string, today: string) => { const n = diff(d, today); if (n === 0) return "Today"; if (n === 1) return "Tomorrow"; if (n === -1) return "Yesterday";
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); };

const total = (r: Job) => (Number(r.value) || 0) * (r.hst ? 1.13 : 1);
const paid = (r: Job) => r.payments.reduce((t: number, p: any) => t + (Number(p.amount) || 0), 0);
const balance = (r: Job) => Math.max(0, Math.round((total(r) - paid(r)) * 100) / 100);
const ms = (r: Job, k: string) => (r.ms || {})[k] || {};
function stepDone(r: Job, k: string) {
  if (k === "deposit") return r.payments.length > 0 || !!ms(r, k).done;
  if (k === "final") return (total(r) > 0 && balance(r) <= 0.5) || !!ms(r, k).done;
  return !!ms(r, k).done;
}
function stage(r: Job) {
  if (r.lost) return "lost";
  if (stepDone(r, "complete")) return "done";
  if (["contract", "deposit", "start"].some((k) => stepDone(r, k))) return "won";
  if (stepDone(r, "estimate")) return "sent";
  if (stepDone(r, "visit")) return "quote";
  if (ms(r, "visit").date) return "visit";
  return "lead";
}

function buildItems(jobs: Job[], events: any[], T: string) {
  const items: { date?: string; time?: string; title: string; sub: string; color: string }[] = [];
  const label: Record<string, string> = { visit: "Site visit", start: "Start work", complete: "Finish work" };
  for (const r of jobs) {
    if (r.lost) continue;
    const st = stage(r), where = [r.address, r.city].filter(Boolean).join(", ");
    for (const k of ["visit", "start", "complete"]) { const m = ms(r, k);
      if (m.date && !m.done && m.date <= T) items.push({ date: m.date, time: m.time, title: `${label[k]} · ${r.name}`, sub: where, color: k === "visit" ? "#30b0c7" : "#34c759" }); }
    if (r.follow && r.follow <= T) items.push({ date: r.follow, title: `Follow up · ${r.name}`, sub: st === "sent" ? `Estimate ${money(total(r))}` : r.type, color: "#ff2d55" });
    else if (st === "sent" && !r.follow && ms(r, "estimate").date && diff(T, ms(r, "estimate").date) >= 4)
      items.push({ date: addDays(ms(r, "estimate").date, 4), title: `Follow up on estimate · ${r.name}`, sub: `${money(total(r))} sent ${fmtDate(ms(r, "estimate").date, T)}`, color: "#ff2d55" });
    if (!stepDone(r, "contacted")) items.push({ title: `Call new lead · ${r.name}`, sub: `${r.type} · ${r.phone || r.email || where}`, color: "#5856d6" });
    else if (!stepDone(r, "visit") && !ms(r, "visit").date) items.push({ title: `Book site visit · ${r.name}`, sub: `${r.type} · ${r.city}`, color: "#30b0c7" });
    if (stepDone(r, "visit") && !stepDone(r, "estimate")) items.push({ title: `Send estimate · ${r.name}`, sub: r.type, color: "#ff9500" });
    if (stepDone(r, "contract") && !stepDone(r, "deposit")) items.push({ title: `Collect deposit · ${r.name}`, sub: total(r) ? `Suggested ${money(total(r) * 0.3)}` : "Contract signed", color: "#af52de" });
    if (stepDone(r, "complete") && !stepDone(r, "final")) items.push({ title: `Collect final payment · ${r.name}`, sub: total(r) ? `Balance ${money(balance(r))}` : "Work completed", color: "#af52de" });
  }
  for (const e of events) { if (e.done || e.date > T) continue; const r = jobs.find((j) => j.id === e.job_id);
    items.push({ date: e.date, time: e.time, title: e.title + (r ? ` · ${r.name}` : ""), sub: e.notes || "Calendar", color: "#007aff" }); }
  return items;
}

function upcoming(jobs: Job[], events: any[], T: string) {
  const out: { date: string; time?: string; title: string }[] = [];
  const label: Record<string, string> = { visit: "Site visit", start: "Work starts", complete: "Target finish" };
  const end = addDays(T, 7);
  for (const r of jobs) { if (r.lost) continue;
    for (const k of ["visit", "start", "complete"]) { const m = ms(r, k); if (m.date > T && m.date <= end && !m.done) out.push({ date: m.date, time: m.time, title: `${label[k]} · ${r.name}` }); }
    if (r.follow > T && r.follow <= end) out.push({ date: r.follow, title: `Follow up · ${r.name}` }); }
  for (const e of events) if (!e.done && e.date > T && e.date <= end) out.push({ date: e.date, time: e.time, title: e.title });
  return out.sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
}

function html(T: string, items: ReturnType<typeof buildItems>, up: ReturnType<typeof upcoming>, stats: { out: number; owed: number; active: number; leads: number }) {
  const late = items.filter((i) => i.date && i.date < T), now = items.filter((i) => i.date === T).sort((a, b) => (a.time || "99").localeCompare(b.time || "99")), todo = items.filter((i) => !i.date);
  const row = (i: any, red = false) => `<tr><td style="padding:11px 0;border-top:1px solid #ececf0;vertical-align:top;width:14px"><div style="width:9px;height:9px;border-radius:50%;background:${i.color};margin-top:5px"></div></td>
    <td style="padding:11px 0 11px 10px;border-top:1px solid #ececf0"><div style="font-size:15px;font-weight:600;color:#1d1d1f">${esc(i.title)}</div><div style="font-size:13px;color:#86868b;margin-top:2px">${esc(i.sub || "")}</div></td>
    <td style="padding:11px 0;border-top:1px solid #ececf0;text-align:right;white-space:nowrap;font-size:13px;color:${red ? "#d0021b" : "#86868b"};font-weight:${red ? 600 : 400};vertical-align:top">${i.time ? fmtTime(i.time) : (i.date ? fmtDate(i.date, T) : "")}</td></tr>`;
  const sect = (title: string, list: any[], red = false) => list.length ? `<h2 style="font-size:18px;margin:26px 0 6px;color:${red ? "#d0021b" : "#1d1d1f"}">${title} <span style="color:#86868b;font-size:14px;font-weight:500">${list.length}</span></h2><table width="100%" cellspacing="0" cellpadding="0">${list.map((i) => row(i, red)).join("")}</table>` : "";
  const d = new Date(T + "T12:00:00Z");
  const n = late.length + now.length + todo.length;
  const tile = (v: string, l: string) => `<td width="25%" style="background:#f5f5f7;border-radius:12px;padding:12px"><div style="font-size:19px;font-weight:700;color:#1d1d1f">${v}</div><div style="font-size:12px;color:#86868b">${l}</div></td>`;
  return `<!doctype html><html><body style="margin:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
  <table width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:18px"><tr><td style="padding:26px 24px 30px">
    <div style="font-size:12px;letter-spacing:.18em;font-weight:700;color:#1d1d1f">NEVACO <span style="color:#d0021b">◆</span> BUILD</div>
    <div style="font-size:13px;font-weight:600;color:#d0021b;text-transform:uppercase;margin-top:18px">${d.toLocaleDateString("en-CA", { weekday: "long", timeZone: "UTC" })}</div>
    <div style="font-size:30px;font-weight:700;color:#1d1d1f;letter-spacing:-.02em">${d.toLocaleDateString("en-CA", { month: "long", day: "numeric", timeZone: "UTC" })}</div>
    <div style="font-size:15px;color:#86868b;margin-top:4px">${n ? `${n} thing${n > 1 ? "s" : ""} to do${late.length ? `, ${late.length} overdue` : ""}.` : "Nothing due today. You're all caught up."}</div>
    <table width="100%" cellspacing="6" cellpadding="0" style="margin:18px -6px 0"><tr>${tile(String(stats.leads), "Open leads")}${tile(money(stats.out), "Quotes out")}${tile(money(stats.owed), "To collect")}${tile(String(stats.active), "Active jobs")}</tr></table>
    ${sect("Overdue", late, true)}${sect("Today", now)}${sect("To Do", todo)}
    ${up.length ? `<h2 style="font-size:18px;margin:26px 0 6px;color:#1d1d1f">Next 7 Days</h2><table width="100%" cellspacing="0" cellpadding="0">${up.slice(0, 10).map((u) => `<tr><td style="padding:9px 0;border-top:1px solid #ececf0;font-size:14px;color:#1d1d1f">${esc(u.title)}</td><td style="padding:9px 0;border-top:1px solid #ececf0;text-align:right;font-size:13px;color:#86868b;white-space:nowrap">${fmtDate(u.date, T)}${u.time ? " · " + fmtTime(u.time) : ""}</td></tr>`).join("")}</table>` : ""}
    <div style="margin-top:28px"><a href="${APP}" style="display:inline-block;background:#1d1d1f;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:12px">Open Job Map</a></div>
  </td></tr></table>
  <div style="font-size:12px;color:#86868b;margin-top:14px">Sent every morning by NEVACO Job Map</div>
  </td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const { date: T, hour } = torontoNow();
  // pg_cron runs at 11:30 and 12:30 UTC so it covers both EDT and EST; only send at 7 AM Toronto time.
  if (url.searchParams.get("force") !== "1" && hour !== 7) return new Response(`skipped (Toronto hour ${hour})`);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const [j, p, e] = await Promise.all([sb.from("jobs").select("*"), sb.from("payments").select("*"), sb.from("events").select("*")]);
  if (j.error || p.error || e.error) return new Response(JSON.stringify(j.error || p.error || e.error), { status: 500 });
  const jobs = (j.data || []).map((r: Job) => ({ ...r, follow: r.follow || "", payments: (p.data || []).filter((x: any) => x.job_id === r.id) }));
  const events = e.data || [];

  const items = buildItems(jobs, events, T), up = upcoming(jobs, events, T);
  const live = jobs.filter((r: Job) => !r.lost);
  const stats = {
    leads: live.filter((r: Job) => ["lead", "visit"].includes(stage(r))).length,
    out: live.filter((r: Job) => stage(r) === "sent").reduce((t: number, r: Job) => t + total(r), 0),
    owed: live.filter((r: Job) => stepDone(r, "contract") || stepDone(r, "complete")).reduce((t: number, r: Job) => t + balance(r), 0),
    active: live.filter((r: Job) => stage(r) === "won").length,
  };
  const late = items.filter((i) => i.date && i.date < T).length;
  const subject = items.length
    ? `Today: ${items.length} thing${items.length > 1 ? "s" : ""} to do${late ? ` (${late} overdue)` : ""}${stats.owed > 0.5 ? ` · ${money(stats.owed)} to collect` : ""}`
    : "Today: all caught up";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "NEVACO Job Map <onboarding@resend.dev>", to: [TO], subject, html: html(T, items, up, stats) }),
  });
  const out = await res.text();
  return new Response(res.ok ? `sent: ${subject}` : `email failed: ${out}`, { status: res.ok ? 200 : 502 });
});
