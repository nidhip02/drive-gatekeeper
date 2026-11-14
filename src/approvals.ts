// Asks you before Claude touches your Drive.
// Requests wait here until you click Allow or Deny — on the approvals page on your Mac, or with the
// buttons on the phone notification. No answer in time = denied.
import "dotenv/config";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readLog } from "./access-log.js";
import { notifyConfig, sendPush, type PushAction } from "./notify.js";

export type Operation = "list" | "read";
export type Decision = "approved" | "denied" | "timeout";
export type Via = "mac" | "phone" | "timeout" | "cancelled";
export type Outcome = { decision: Decision; via: Via };

type PendingRequest = {
  id: string;
  phoneKey: string;
  operation: Operation;
  tool: string;
  fileName?: string | undefined;
  fileId?: string | undefined;
  query?: string | undefined;
  createdAt: number;
  expiresAt: number;
  resolve: (decision: Decision, via: Via) => void;
};

// Secret that protects the approvals page. Set APPROVAL_TOKEN in .env to keep it the same across restarts.
export const APPROVAL_TOKEN = process.env.APPROVAL_TOKEN || randomBytes(16).toString("hex");
const TIMEOUT_SECONDS = Number(process.env.APPROVAL_TIMEOUT_SECONDS || 90);
const TIMEOUT_MS = TIMEOUT_SECONDS * 1000;

const pending = new Map<string, PendingRequest>();

export function describe(r: { operation: Operation; fileName?: string | undefined; query?: string | undefined }) {
  return r.operation === "read"
    ? `READ the contents of "${r.fileName}"`
    : `LIST file names matching "${r.query}"`;
}

function warnIfFailed(what: string, result: { ok: boolean; error?: string | undefined }) {
  if (!result.ok) console.warn(`⚠️  Phone alert (${what}) not sent: ${result.error}`);
}

export function requestApproval(
  request: Pick<PendingRequest, "operation" | "tool" | "fileName" | "fileId" | "query">,
  signal?: AbortSignal,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const phoneKey = randomBytes(16).toString("hex"); // one-time key for the phone buttons of THIS request only
    const finish = (decision: Decision, via: Via) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      if (via !== "phone") void announceOutcome(request, decision, via); // phone taps clear their own notification
      resolve({ decision, via });
    };
    const timer = setTimeout(() => finish("timeout", "timeout"), TIMEOUT_MS);
    signal?.addEventListener("abort", () => finish("denied", "cancelled"));
    const now = Date.now();
    pending.set(id, { ...request, id, phoneKey, createdAt: now, expiresAt: now + TIMEOUT_MS, resolve: finish });
    console.log(`⏳ Waiting for your approval: ${describe(request)}`);
    void notifyNewRequest(request, id, phoneKey).then((r) => warnIfFailed("new request", r));
  });
}

async function notifyNewRequest(
  request: Pick<PendingRequest, "operation" | "fileName" | "query">,
  id: string,
  phoneKey: string,
) {
  const { publicUrl, hideNames } = notifyConfig;
  const what = hideNames
    ? request.operation === "read" ? "READ a file" : "SEARCH your Drive"
    : describe(request);
  const actions: PushAction[] | undefined = publicUrl
    ? (["allow", "deny"] as const).map((choice) => ({
        action: "http" as const,
        label: choice === "allow" ? "Allow" : "Deny",
        url: `${publicUrl}/a/${id}/${phoneKey}/${choice}`,
        method: "POST" as const,
        clear: true,
      }))
    : undefined;
  return sendPush({
    title: "Claude is asking to use your Drive",
    message: `Claude wants to ${what}. Auto-denies in ${TIMEOUT_SECONDS}s.${actions ? "" : " Open the approvals page on your Mac to answer."}`,
    priority: 4,
    actions,
  });
}

// A quiet follow-up so a phone that still shows the old buttons knows what happened.
async function announceOutcome(
  request: Pick<PendingRequest, "operation" | "fileName" | "query">,
  decision: Decision,
  via: Via,
) {
  const what = notifyConfig.hideNames ? (request.operation === "read" ? "a file read" : "a Drive search") : describe(request);
  const result =
    via === "timeout" ? `Timed out, so it was denied: ${what}`
    : via === "cancelled" ? `Claude cancelled the request: ${what}`
    : `${decision === "approved" ? "Allowed" : "Denied"} on your Mac: ${what}`;
  warnIfFailed("outcome", await sendPush({ title: "Drive Gatekeeper", message: result, priority: 1 }));
}

function sameSecret(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Public side (reachable through the tunnel): ONLY the per-request Allow/Deny phone buttons.
// URL shape: POST /a/<request id>/<one-time key>/<allow|deny>. Anything else gets "Not found".
export function handlePhoneDecision(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const match = url.pathname.match(/^\/a\/([0-9a-f-]{36})\/([0-9a-f]{32})\/(allow|deny)$/);
  if (!match) return false;
  req.resume();
  const [, id, key, choice] = match as unknown as [string, string, string, "allow" | "deny"];
  const item = pending.get(id);
  // POST only, so link previews and scanners can't trigger it by merely fetching the URL.
  if (req.method !== "POST" || !item || !sameSecret(key, item.phoneKey)) {
    res.writeHead(404).end("Not found");
    return true;
  }
  const allow = choice === "allow";
  console.log(`${allow ? "✅ Allowed" : "⛔ Denied"} from your phone: ${describe(item)}`);
  item.resolve(allow ? "approved" : "denied", "phone");
  res.writeHead(200).end("ok");
  return true;
}

// Local side (port 8788, this Mac only): the approvals page, access log and settings.
export function handleApprovalsHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!url.pathname.startsWith("/approvals")) return false;
  if (!sameSecret(url.searchParams.get("token"), APPROVAL_TOKEN)) {
    res.writeHead(403).end("Forbidden: missing or wrong token");
    return true;
  }
  const json = (data: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));

  if (url.pathname === "/approvals/pending.json") {
    return json([...pending.values()].map(({ resolve, phoneKey, ...rest }) => ({ ...rest, summary: describe(rest) }))), true;
  }

  if (url.pathname === "/approvals/log.json") {
    return json(readLog(Number(url.searchParams.get("limit") || 200))), true;
  }

  if (url.pathname === "/approvals/status.json") {
    const { enabled, server, topic, publicUrl, hideNames } = notifyConfig;
    return json({ enabled, server, topic, buttons: Boolean(publicUrl), hideNames }), true;
  }

  if (url.pathname === "/approvals/test-notify" && req.method === "POST") {
    void sendPush({
      title: "Drive Gatekeeper test",
      message: "If you can read this, phone alerts are working.",
      priority: 3,
    }).then(json);
    return true;
  }

  if (url.pathname === "/approvals/decide" && req.method === "POST") {
    const item = pending.get(url.searchParams.get("id") ?? "");
    if (!item) {
      res.writeHead(404).end("Request no longer pending");
      return true;
    }
    const allow = url.searchParams.get("decision") === "allow";
    console.log(`${allow ? "✅ You allowed" : "⛔ You denied"}: ${describe(item)}`);
    item.resolve(allow ? "approved" : "denied", "mac");
    res.writeHead(200).end("ok");
    return true;
  }

  if (url.pathname === "/approvals") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    return true;
  }

  res.writeHead(404).end("Not found");
  return true;
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Drive Gatekeeper</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 22px; } h2 { font-size: 18px; margin-top: 36px; } .muted { color: #777; font-size: 14px; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin: 12px 0; }
  .op { display: inline-block; font-weight: 600; font-size: 13px; padding: 2px 8px; border-radius: 6px; }
  .read { background: #fdecea; color: #a12b1f; } .list { background: #e8f0fe; color: #1a4fa0; }
  button { font-size: 15px; padding: 8px 18px; border-radius: 8px; border: 1px solid #ccc; cursor: pointer; margin-right: 8px; background: white; }
  .allow { background: #1e7e34; color: white; border-color: #1e7e34; }
  .deny { background: white; color: #a12b1f; border-color: #a12b1f; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { color: #777; font-weight: 500; }
  .pill { font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 10px; white-space: nowrap; }
  .allowed { background: #e3f4e7; color: #1e7e34; } .denied { background: #fdecea; color: #a12b1f; } .error { background: #fff3d6; color: #8a5a00; }
  select { font-size: 14px; padding: 4px 8px; }
  code { background: #f3f3f3; padding: 1px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
</style></head>
<body>
<h1>Drive Gatekeeper</h1>
<p class="muted">Keep this tab open. Claude's requests to your Google Drive appear here, and on your phone if alerts are on.</p>

<div id="list"></div>

<h2>Phone alerts</h2>
<div id="phone" class="card muted">Loading…</div>

<h2>Access log</h2>
<p class="muted">Every attempt, newest first — including ones that were blocked or declined.
  Show: <select id="filter"><option value="">everything</option><option value="allowed">allowed</option><option value="denied">denied</option><option value="error">errors</option></select>
  <button id="notify" style="padding:4px 10px;font-size:13px">Also notify in this browser</button></p>
<div id="log"></div>

<script>
  const token = new URLSearchParams(location.search).get("token");
  const seen = new Set();
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const api = (path, opts) => fetch("/approvals/" + path + (path.indexOf("?") < 0 ? "?" : "&") + "token=" + token, opts);
  document.getElementById("notify").onclick = () => Notification.requestPermission();
  document.getElementById("filter").onchange = refreshLog;

  async function decide(id, decision) {
    await api("decide?id=" + id + "&decision=" + decision, { method: "POST" });
    refresh();
  }

  async function refresh() {
    const items = await (await api("pending.json")).json();
    document.title = items.length ? "(" + items.length + ") Approval needed" : "Drive Gatekeeper";
    for (const it of items) if (!seen.has(it.id)) {
      seen.add(it.id);
      if (window.Notification && Notification.permission === "granted") new Notification("Claude wants to " + it.summary);
    }
    document.getElementById("list").innerHTML = items.length === 0
      ? '<p class="muted">No pending requests.</p>'
      : items.map((it) => {
          const secs = Math.max(0, Math.round((it.expiresAt - Date.now()) / 1000));
          return '<div class="card"><span class="op ' + it.operation + '">' + it.operation.toUpperCase() + '</span>' +
            '<p><b>Claude wants to ' + esc(it.summary) + '</b></p>' +
            (it.fileId ? '<p class="muted">File ID: ' + esc(it.fileId) + '</p>' : '') +
            '<p class="muted">Auto-denies in ' + secs + 's</p>' +
            '<button class="allow" onclick="decide(\\'' + it.id + '\\',\\'allow\\')">Allow</button>' +
            '<button class="deny" onclick="decide(\\'' + it.id + '\\',\\'deny\\')">Deny</button></div>';
        }).join("");
  }

  async function refreshLog() {
    const want = document.getElementById("filter").value;
    const rows = (await (await api("log.json?limit=300")).json()).filter((r) => !want || r.decision === want);
    document.getElementById("log").innerHTML = rows.length === 0
      ? '<p class="muted">Nothing logged yet.</p>'
      : '<table><tr><th>When</th><th>What</th><th>Result</th><th>Details</th></tr>' + rows.map((r) => {
          const what = r.operation === "read" ? "READ " + esc(r.fileName || r.fileId || "") : "LIST " + esc(r.query || "");
          const detail = [r.detail, r.approvedVia ? "approved on " + r.approvedVia : ""].filter(Boolean).join(" · ");
          return '<tr><td>' + esc(new Date(r.time).toLocaleString()) + '</td><td>' + what + '</td>' +
            '<td><span class="pill ' + esc(r.decision) + '">' + esc(r.decision) + '</span></td><td class="muted">' + esc(detail) + '</td></tr>';
        }).join("") + '</table>';
  }

  async function refreshPhone() {
    const s = await (await api("status.json")).json();
    const box = document.getElementById("phone");
    if (!s.enabled) { box.innerHTML = "Phone alerts are turned off (NTFY_DISABLED=1 in .env)."; return; }
    box.innerHTML =
      '<p>1. Install the free <b>ntfy</b> app on your phone.<br>2. Tap + and subscribe to this topic' +
      (s.server === "https://ntfy.sh" ? "" : " on server <code>" + esc(s.server) + "</code>") + ': <code>' + esc(s.topic) + '</code></p>' +
      '<p>' + (s.buttons ? "Allow/Deny buttons are on." : "Allow/Deny buttons are off: add PUBLIC_URL to .env.") +
      (s.hideNames ? " File names are hidden in notifications." : "") + '</p>' +
      '<button id="testbtn">Send a test notification</button> <span id="testresult"></span>';
    document.getElementById("testbtn").onclick = async () => {
      const out = document.getElementById("testresult");
      out.textContent = "Sending…";
      const r = await (await api("test-notify", { method: "POST" })).json();
      out.textContent = r.ok ? "Sent — check your phone." : "Failed: " + (r.error || "unknown error");
    };
  }

  refresh(); refreshLog(); refreshPhone();
  setInterval(refresh, 1500);
  setInterval(refreshLog, 5000);
</script>
</body></html>`;
