// Appends one line per access attempt to access-log.jsonl (allowed, denied, or failed).
import { appendFileSync } from "node:fs";

const LOG_PATH = "access-log.jsonl";

export type LogEntry = {
  tool: string;
  operation: "list" | "read";
  decision: "allowed" | "denied" | "error";
  fileId?: string | undefined;
  fileName?: string | undefined;
  query?: string | undefined;
  detail?: string | undefined;
};

export function logAccess(entry: LogEntry) {
  const line = { time: new Date().toISOString(), ...entry };
  appendFileSync(LOG_PATH, JSON.stringify(line) + "\n");
  console.log(`[${line.time}] ${entry.decision.toUpperCase()} ${entry.operation} via ${entry.tool}`
    + (entry.fileName ? ` "${entry.fileName}"` : "") + (entry.query ? ` query="${entry.query}"` : ""));
}
