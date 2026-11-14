// Asks you before Claude touches your Drive.
// Requests wait here until you click Allow or Deny on the approvals page (or they time out → denied).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Operation = "list" | "read";
export type Decision = "approved" | "denied" | "timeout";

type PendingRequest = {
  id: string;
  operation: Operation;
  tool: string;
  fileName?: string | undefined;
  fileId?: string | undefined;
  query?: string | undefined;
  createdAt: number;
  expiresAt: number;
  resolve: (decision: Decision) => void;
};

// Secret that protects the approvals page. Set APPROVAL_TOKEN in .env to keep it the same across restarts.
export const APPROVAL_TOKEN = process.env.APPROVAL_TOKEN || randomBytes(16).toString("hex");
const TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_SECONDS || 90) * 1000;

const pending = new Map<string, PendingRequest>();

export function requestApproval(
  request: Pick<PendingRequest, "operation" | "tool" | "fileName" | "fileId" | "query">,
  signal?: AbortSignal,
): Promise<Decision> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const finish = (decision: Decision) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      resolve(decision);
    };
    const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    signal?.addEventListener("abort", () => finish("denied"));
    const now = Date.now();
    pending.set(id, { ...request, id, createdAt: now, expiresAt: now + TIMEOUT_MS, resolve: finish });
    console.log(`⏳ Waiting for your approval: ${describe(request)}`);
  });
}

export function describe(r: { operation: Operation; fileName?: string | undefined; query?: string | undefined }) {
  return r.operation === "read"
    ? `READ the contents of "${r.fileName}"`
    : `LIST file names matching "${r.query}"`;
}

function tokenOk(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(APPROVAL_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Handles /approvals URLs. Returns true if it handled the request.
export function handleApprovalsHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!url.pathname.startsWith("/approvals")) return false;
  if (!tokenOk(url.searchParams.get("token"))) {
    res.writeHead(403).end("Forbidden: missing or wrong token");
    return true;
  }

  if (url.pathname === "/approvals/pending.json") {
    const list = [...pending.values()].map(({ resolve, ...rest }) => ({ ...rest, summary: describe(rest) }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
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
    item.resolve(allow ? "approved" : "denied");
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
<html><head><meta charset="utf-8"><title>Drive Gatekeeper – approvals</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 22px; } .muted { color: #777; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin: 12px 0; }
  .op { display: inline-block; font-weight: 600; font-size: 13px; padding: 2px 8px; border-radius: 6px; }
  .read { background: #fdecea; color: #a12b1f; } .list { background: #e8f0fe; color: #1a4fa0; }
  button { font-size: 15px; padding: 8px 18px; border-radius: 8px; border: 1px solid #ccc; cursor: pointer; margin-right: 8px; }
  .allow { background: #1e7e34; color: white; border-color: #1e7e34; }
  .deny { background: white; color: #a12b1f; border-color: #a12b1f; }
</style></head>
<body>
<h1>Drive Gatekeeper</h1>
<p class="muted">Keep this tab open. Claude's requests to your Google Drive appear here.</p>
<button id="notify">Turn on desktop notifications</button>
<div id="list"></div>
<script>
  const token = new URLSearchParams(location.search).get("token");
  const seen = new Set();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  document.getElementById("notify").onclick = () => Notification.requestPermission();
  async function decide(id, decision) {
    await fetch("/approvals/decide?token=" + token + "&id=" + id + "&decision=" + decision, { method: "POST" });
    refresh();
  }
  async function refresh() {
    const items = await (await fetch("/approvals/pending.json?token=" + token)).json();
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
  refresh(); setInterval(refresh, 1500);
</script>
</body></html>`;
