// The gatekeeper: an MCP server that sits between Claude and your Google Drive.
// Run with: npm start   (and `npm run tunnel` in a second window to let Claude reach it)
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { google, type drive_v3 } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getAuthClient } from "./google-auth.js";
import { isBlocked, loadBlockedIds } from "./blocklist.js";
import { logAccess } from "./access-log.js";
import { APPROVAL_TOKEN, handleApprovalsHttp, requestApproval, type Decision, type Operation } from "./approvals.js";

const PORT = 8787; // MCP endpoint — this is what the tunnel exposes to the internet
const APPROVALS_PORT = 8788; // approvals page — only reachable from this Mac, never through the tunnel

// The secret part of your connector URL. Created once, kept in connector-secret.txt (private, in .gitignore).
// Anyone without it gets "Not found". To revoke access, delete the file and restart.
const SECRET_PATH = "connector-secret.txt";
if (!existsSync(SECRET_PATH)) writeFileSync(SECRET_PATH, randomBytes(24).toString("base64url"));
const CONNECTOR_SECRET = readFileSync(SECRET_PATH, "utf8").trim();
const MCP_PATH = `/mcp/${CONNECTOR_SECRET}`;
const MAX_CHARS = 50_000; // keep very long files from flooding the conversation

const drive = google.drive({ version: "v3", auth: await getAuthClient() });

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

// Pauses until you approve on the approvals page. Sends "still waiting" pings so the
// client doesn't give up while you decide.
async function askUser(
  extra: { signal: AbortSignal; _meta?: { progressToken?: string | number | undefined } | undefined; sendNotification: (n: any) => Promise<void> },
  request: { operation: Operation; tool: string; fileName?: string | undefined; fileId?: string | undefined; query?: string | undefined },
): Promise<Decision> {
  const progressToken = extra._meta?.progressToken;
  let tick = 0;
  const ping = progressToken === undefined ? undefined : setInterval(() => {
    tick++;
    extra.sendNotification({ method: "notifications/progress",
      params: { progressToken, progress: tick, message: "Waiting for the user to approve in Drive Gatekeeper" } }).catch(() => {});
  }, 5000);
  try {
    return await requestApproval(request, extra.signal);
  } finally {
    if (ping) clearInterval(ping);
  }
}

const DECLINED: Record<Exclude<Decision, "approved">, string> = {
  denied: "The user declined this request.",
  timeout: "The user did not approve this request in time.",
};

// Same reply whether a file is blocked or doesn't exist, so Claude can't tell them apart.
const NOT_AVAILABLE = "This file is not available.";

function buildServer(): McpServer {
  const server = new McpServer({ name: "drive-gatekeeper", version: "0.1.0" });

  server.registerTool(
    "search_files",
    {
      title: "Search Google Drive",
      description: "Search the user's Google Drive by file name or content. Returns file names and IDs.",
      inputSchema: { query: z.string().min(1).describe("Words to search for") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }, extra) => {
      const decision = await askUser(extra, { operation: "list", tool: "search_files", query });
      if (decision !== "approved") {
        logAccess({ tool: "search_files", operation: "list", decision: "denied", query, detail: `user ${decision}` });
        return text(DECLINED[decision], true);
      }
      try {
        const safe = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `(name contains '${safe}' or fullText contains '${safe}') and trashed = false`,
          pageSize: 25,
          fields: "files(id, name, mimeType, modifiedTime)",
        });
        const blocked = loadBlockedIds();
        const cache = new Map<string, string[]>();
        const visible: drive_v3.Schema$File[] = [];
        let hidden = 0;
        for (const file of res.data.files ?? []) {
          if (file.id && !(await isBlocked(drive, file.id, blocked, cache).catch(() => true))) visible.push(file);
          else hidden++;
        }
        logAccess({ tool: "search_files", operation: "list", decision: "allowed", query,
          detail: `returned ${visible.length}, hid ${hidden} blocked` });
        if (visible.length === 0) return text("No matching files found.");
        return text(visible.map((f) => `- ${f.name} (id: ${f.id}, type: ${f.mimeType}, modified: ${f.modifiedTime})`).join("\n"));
      } catch (err) {
        logAccess({ tool: "search_files", operation: "list", decision: "error", query, detail: (err as Error).message });
        return text("Search failed.", true);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a Google Drive file",
      description: "Read the text content of a Google Drive file by its ID (from search_files).",
      inputSchema: { fileId: z.string().min(1).describe("The file's ID") },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }, extra) => {
      try {
        if (await isBlocked(drive, fileId)) {
          logAccess({ tool: "read_file", operation: "read", decision: "denied", fileId, detail: "on blocklist" });
          return text(NOT_AVAILABLE, true);
        }
      } catch {
        logAccess({ tool: "read_file", operation: "read", decision: "denied", fileId, detail: "not found or not accessible" });
        return text(NOT_AVAILABLE, true);
      }

      try {
        const meta = await drive.files.get({ fileId, fields: "id, name, mimeType" });
        const { name, mimeType } = meta.data;

        const decision = await askUser(extra, { operation: "read", tool: "read_file", fileName: name ?? fileId, fileId });
        if (decision !== "approved") {
          logAccess({ tool: "read_file", operation: "read", decision: "denied", fileId, fileName: name ?? undefined,
            detail: `user ${decision}` });
          return text(DECLINED[decision], true);
        }

        let content: string;

        const exportAs: Record<string, string> = {
          "application/vnd.google-apps.document": "text/plain",
          "application/vnd.google-apps.spreadsheet": "text/csv",
          "application/vnd.google-apps.presentation": "text/plain",
        };
        if (mimeType && exportAs[mimeType]) {
          const res = await drive.files.export({ fileId, mimeType: exportAs[mimeType] }, { responseType: "text" });
          content = String(res.data);
        } else if (mimeType && (mimeType.startsWith("text/") || mimeType === "application/json")) {
          const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
          content = String(res.data);
        } else {
          logAccess({ tool: "read_file", operation: "read", decision: "error", fileId, fileName: name ?? undefined,
            detail: `unsupported type ${mimeType}` });
          return text(`"${name}" is a ${mimeType} file, which this gatekeeper can't read yet.`, true);
        }

        const truncated = content.length > MAX_CHARS;
        logAccess({ tool: "read_file", operation: "read", decision: "allowed", fileId, fileName: name ?? undefined,
          detail: `${content.length} chars${truncated ? " (truncated)" : ""}` });
        return text(`# ${name}\n\n${content.slice(0, MAX_CHARS)}${truncated ? "\n\n[...truncated]" : ""}`);
      } catch (err) {
        logAccess({ tool: "read_file", operation: "read", decision: "error", fileId, detail: (err as Error).message });
        return text("Could not read this file.", true);
      }
    },
  );

  return server;
}

// A fresh server per request ("stateless" mode) keeps things simple.
const mcpHttpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end("Not found"); // wrong or missing secret: reveal nothing
    return;
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({}); // no session ID = stateless; streams so "still waiting" pings get through
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

const approvalsHttpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${APPROVALS_PORT}`);
  if (!handleApprovalsHttp(req, res, url)) res.writeHead(404).end("Not found");
});

// 127.0.0.1 = only reachable from your own computer (the tunnel connects from here too).
mcpHttpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`Drive gatekeeper running.`);
  console.log(`Blocking ${loadBlockedIds().size} item(s) from never_touch.txt`);
  console.log(`\nLocal MCP URL (for MCP Inspector): http://localhost:${PORT}${MCP_PATH}`);
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
  console.log(publicUrl
    ? `Claude connector URL: ${publicUrl}${MCP_PATH}`
    : `Claude connector URL: https://<your-ngrok-domain>${MCP_PATH}  (add PUBLIC_URL to .env to print it in full)`);
  console.log("Keep both URLs private — they work like a password.");
});

approvalsHttpServer.listen(APPROVALS_PORT, "127.0.0.1", () => {
  const approvalsUrl = `http://localhost:${APPROVALS_PORT}/approvals?token=${APPROVAL_TOKEN}`;
  console.log(`\nApprovals page (keep it open): ${approvalsUrl}\n`);
  if (process.platform === "darwin") exec(`open "${approvalsUrl}"`);
});
