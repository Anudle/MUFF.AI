/**
 * One-time interactive OAuth handshake (ANU-11).
 * Prints the Yahoo consent URL, waits for you to paste the code back,
 * exchanges it for tokens, and persists them to .tokens.json.
 */

import { createInterface } from "node:readline/promises";
import { buildAuthUrl, exchangeCode } from "../src/yahoo/oauth.ts";
import { saveTokens } from "../src/yahoo/client.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log("\n1. Open this URL in your browser and click 'Agree':\n");
console.log("   " + buildAuthUrl() + "\n");
console.log("2. Yahoo will redirect to https://localhost:8000/?code=... — that page");
console.log("   will fail to load (nothing's listening), which is expected.\n");

const pasted = await rl.question("3. Paste the code, or the whole dead URL, here: ");
rl.close();

const match = pasted.match(/[?&]code=([^&\s]+)/);
const code = match ? decodeURIComponent(match[1]) : pasted.trim();

const tokens = await exchangeCode(code);
await saveTokens(tokens);

console.log("\n✅ Tokens saved to .tokens.json (gitignored).");
console.log("   Run `npm run smoke` to verify the connection.\n");
