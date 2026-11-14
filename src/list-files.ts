// Test script: confirms we can talk to your Google Drive.
// Run with: npm run test:drive
import { google } from "googleapis";
import { getAuthClient } from "./google-auth.js";

const auth = await getAuthClient();
const drive = google.drive({ version: "v3", auth });

const res = await drive.files.list({
  pageSize: 10,
  orderBy: "modifiedTime desc",
  fields: "files(id, name, mimeType)",
});

console.log("\nConnected! Your 10 most recently changed files:\n");
for (const file of res.data.files ?? []) {
  console.log(`- ${file.name}   (id: ${file.id})`);
}
