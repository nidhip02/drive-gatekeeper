// Reads never_touch.txt and decides whether a file is off-limits.
// The file is re-read on every check, so edits take effect immediately (no restart).
import { existsSync, readFileSync } from "node:fs";
import type { drive_v3 } from "googleapis";

const BLOCKLIST_PATH = "never_touch.txt";
const ID = "[a-zA-Z0-9_-]{15,}";

// Accepts full Drive/Docs links or bare IDs, one per line. Anything after # is a note.
export function loadBlockedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(BLOCKLIST_PATH)) return ids;
  for (const rawLine of readFileSync(BLOCKLIST_PATH, "utf8").split("\n")) {
    const line = rawLine.split("#")[0]!.replace(/["']/g, "").trim();
    if (!line) continue;
    const fromLink =
      line.match(new RegExp(`/d/(${ID})`)) ??
      line.match(new RegExp(`/folders/(${ID})`)) ??
      line.match(new RegExp(`[?&]id=(${ID})`));
    if (fromLink) ids.add(fromLink[1]!);
    else if (new RegExp(`^${ID}$`).test(line)) ids.add(line);
  }
  return ids;
}

// A file is blocked if it is on the list, or sits anywhere inside a blocked folder.
// If we can't work out where a file lives, we refuse ("fail closed") to be safe.
export async function isBlocked(
  drive: drive_v3.Drive,
  fileId: string,
  blocked: Set<string> = loadBlockedIds(),
  parentCache: Map<string, string[]> = new Map(),
): Promise<boolean> {
  let toCheck = [fileId];
  const seen = new Set<string>();
  for (let depth = 0; depth < 30 && toCheck.length > 0; depth++) {
    const next: string[] = [];
    for (const id of toCheck) {
      if (blocked.has(id)) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      let parents = parentCache.get(id);
      if (!parents) {
        try {
          const res = await drive.files.get({ fileId: id, fields: "parents", supportsAllDrives: true });
          parents = res.data.parents ?? [];
        } catch {
          // Can't see this item's location. The file itself must be visible to reach here,
          // so an unreadable parent folder means "unknown" → block to be safe.
          if (id === fileId) throw new Error("File not found or not accessible");
          return true;
        }
        parentCache.set(id, parents);
      }
      next.push(...parents);
    }
    toCheck = next;
  }
  return false;
}
