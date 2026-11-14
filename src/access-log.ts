// Appends one line per access attempt to access-log.jsonl (allowed, denied, or failed).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const LOG_PATH = "access-log.jsonl";

export type LogEntry = {
  tool: string;
  operation: "list" | "read";
  decision: "allowed" | "denied" | "error";
  fileId?: string | undefined;
  fileName?: string | undefined;
  query?: string | undefined;
  detail?: string | undefined;
  approvedVia?: string | undefined;
};

export function logAccess(entry: LogEntry) {
  const line = { time: new Date().toISOString(), ...entry };
  appendFileSync(LOG_PATH, JSON.stringify(line) + "\n");
  console.log(`[${line.time}] ${entry.decision.toUpperCase()} ${entry.operation} via ${entry.tool}`
    + (entry.fileName ? ` "${entry.fileName}"` : "") + (entry.query ? ` query="${entry.query}"` : ""));
}

// Newest entries first — used by the "Access log" section of the approvals page.
export function readLog(limit = 200): Record<string, unknown>[] {
  if (!existsSync(LOG_PATH)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip a damaged line rather than failing the whole page
    }
  }
  return entries.reverse().slice(0, Math.min(Math.max(limit, 1), 1000));
}
