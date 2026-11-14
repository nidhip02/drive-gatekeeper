# Drive Gatekeeper

A personal MCP server that sits between Claude and Google Drive, so Claude only gets the access you allow.

- **Blocklist** — files and folders in `never_touch.txt` are never shown or opened (including everything inside blocked folders).
- **Approval for every access** — each search (LIST) or read (READ) waits for you to click Allow or Deny on a local approvals page. Unanswered requests are denied after 90 seconds.
- **Access log** — every attempt, allowed or not, is appended to `access-log.jsonl`.

Read-only for now: it uses the `drive.readonly` scope, so it cannot change your files.

## How it works

```
Claude ──► ngrok tunnel ──► gatekeeper on your Mac ──► Google Drive API
                                 │
                                 ├─ blocklist check (never_touch.txt)
                                 ├─ approvals page (localhost only)
                                 └─ access-log.jsonl
```

## Setup

1. **Google Cloud**: create a project, enable the Google Drive API, set up the OAuth consent screen (External, add yourself as a test user, scope `drive.readonly`), and create a *Web application* OAuth client with redirect URI `http://localhost:3000/oauth2callback`.
2. **Install**: `npm install`
3. **`.env`** (never commit this):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
   PUBLIC_URL=https://<your-ngrok-domain>
   # optional
   APPROVAL_TOKEN=a-long-random-phrase
   APPROVAL_TIMEOUT_SECONDS=90
   ```
4. **Sign in to Google once**: `npm run test:drive`
5. **Blocklist**: copy `never_touch.example.txt` to `never_touch.txt` and add Drive links or IDs, one per line.

## Run

| Window | Command | What it does |
|---|---|---|
| 1 | `npm start` | Starts the gatekeeper, prints the connector URL, opens the approvals page |
| 2 | `npm run tunnel` | Makes it reachable by Claude through ngrok |
| optional | `npm run inspect` | Opens MCP Inspector for manual testing |

Then add the printed **Claude connector URL** as a custom connector in Claude (no sign-in), and disconnect Claude's official Google Drive connector so it can't bypass the gatekeeper.

## Files

| File | Purpose | In git? |
|---|---|---|
| `src/server.ts` | MCP server and tools (`search_files`, `read_file`) | yes |
| `src/blocklist.ts` | Reads `never_touch.txt`, checks files and parent folders | yes |
| `src/approvals.ts` | Approvals page and waiting logic | yes |
| `src/access-log.ts` | Writes `access-log.jsonl` | yes |
| `src/google-auth.ts` | Google sign-in, saves `tokens.json` | yes |
| `.env`, `tokens.json`, `connector-secret.txt` | Secrets | **no** |
| `never_touch.txt`, `access-log.jsonl` | Your personal blocklist and log | **no** |

## Security notes

- The connector URL contains a secret; treat it like a password. Delete `connector-secret.txt` and restart to rotate it.
- The approvals page listens on `127.0.0.1:8788` only and is never exposed through the tunnel.
- Blocked files return the same "not available" message as missing files, so their existence isn't revealed.
