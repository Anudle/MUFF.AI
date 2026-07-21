/**
 * MUFF-38 — run the Tuesday digest pipeline from the CLI.
 *
 *   npm run digest                → last completed week, print to stdout (dry run)
 *   npm run digest -- --week 15   → specific week
 *   npm run digest -- --send      → also deliver to TELEGRAM_CHAT_ID
 *
 * The pipeline body lives in src/digest/run.ts, shared with the scheduled
 * Lambda (MUFF-43) — this file is only argument parsing.
 */

import { runDigest } from "../src/digest/run.ts";

const args = process.argv.slice(2);
const weekArg = args.indexOf("--week");
const week = weekArg !== -1 ? Number(args[weekArg + 1]) : undefined;
const send = args.includes("--send");

const result = await runDigest({ week, send });
console.log(`\n${result.text}\n`);
