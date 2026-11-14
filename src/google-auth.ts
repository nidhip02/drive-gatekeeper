// Handles signing in to Google and remembering that sign-in.
// The first run opens a sign-in link; after that, tokens.json keeps you signed in.
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { google } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const TOKEN_PATH = "tokens.json"; // private: listed in .gitignore
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in your .env file`);
  return value;
}

function saveTokens(tokens: object) {
  const existing = existsSync(TOKEN_PATH) ? JSON.parse(readFileSync(TOKEN_PATH, "utf8")) : {};
  writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
}

export async function getAuthClient(): Promise<OAuth2Client> {
  const client = new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    requireEnv("GOOGLE_REDIRECT_URI"),
  );

  // Google hands out fresh access tokens every hour; save them so we stay signed in.
  client.on("tokens", (tokens) => saveTokens(tokens));

  if (existsSync(TOKEN_PATH)) {
    client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, "utf8")));
    return client;
  }

  await signInWithBrowser(client);
  return client;
}

// Starts a tiny local web page that catches Google's reply after you sign in.
function signInWithBrowser(client: OAuth2Client): Promise<void> {
  const redirect = new URL(requireEnv("GOOGLE_REDIRECT_URI"));
  const authUrl = client.generateAuthUrl({
    access_type: "offline", // gives us a long-lived "refresh token"
    prompt: "consent",
    scope: SCOPES,
  });

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", redirect.origin);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      try {
        if (error) throw new Error(`Google said: ${error}`);
        if (!code) throw new Error("No sign-in code in Google's reply");
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        saveTokens(tokens);
        res.end("Signed in! You can close this tab and go back to Terminal.");
        resolve();
      } catch (err) {
        res.end(`Sign-in failed: ${(err as Error).message}`);
        reject(err);
      } finally {
        server.close();
      }
    });

    server.listen(Number(redirect.port || 80), () => {
      console.log("\nOpen this link in your browser to sign in to Google:\n");
      console.log(authUrl + "\n");
      console.log("Waiting for you to finish signing in...");
    });
  });
}
