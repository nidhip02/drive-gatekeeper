// Sends push notifications to your phone through ntfy (https://ntfy.sh) — free, no account needed.
// You install the ntfy app on your phone and subscribe to your private topic name.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TOPIC_FILE = "ntfy-topic.txt"; // private: listed in .gitignore

const enabled = process.env.NTFY_DISABLED !== "1";

// The topic name works like a password: anyone who knows it can read your notifications.
function loadTopic(): string {
  if (process.env.NTFY_TOPIC) return process.env.NTFY_TOPIC.trim();
  if (!enabled) return "";
  if (!existsSync(TOPIC_FILE)) writeFileSync(TOPIC_FILE, "drivegate-" + randomBytes(12).toString("hex"));
  return readFileSync(TOPIC_FILE, "utf8").trim();
}

export const notifyConfig = {
  enabled,
  server: (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, ""),
  topic: loadTopic(),
  // Your public tunnel address. Needed for the Allow/Deny buttons, because your phone must be able to reach it.
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, "") as string | undefined,
  // Set NTFY_HIDE_NAMES=1 to keep file names and search words out of notifications.
  hideNames: process.env.NTFY_HIDE_NAMES === "1",
};

export type PushAction = { action: "http"; label: string; url: string; method: "POST"; clear: boolean };
export type PushResult = { ok: boolean; error?: string | undefined };

export async function sendPush(push: {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  actions?: PushAction[] | undefined;
}): Promise<PushResult> {
  if (!notifyConfig.enabled) return { ok: false, error: "Phone alerts are turned off (NTFY_DISABLED=1)" };
  try {
    const res = await fetch(`${notifyConfig.server}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: notifyConfig.topic,
        title: push.title,
        message: push.message,
        priority: push.priority ?? 3,
        ...(push.actions ? { actions: push.actions } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `ntfy replied ${res.status} ${body.slice(0, 120)}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
