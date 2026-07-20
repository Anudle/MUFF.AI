/**
 * MUFF-38 — run the Tuesday digest pipeline.
 *
 *   npm run digest                → last completed week, print to stdout (dry run)
 *   npm run digest -- --week 15   → specific week
 *   npm run digest -- --send      → also deliver to TELEGRAM_CHAT_ID
 *
 * This script IS the future Lambda handler body: gather → generate → render
 * → deliver. MUFF-39 wraps it in a handler and puts EventBridge (Tue ~7am MT)
 * in front of it.
 */

import { gatherWeekFacts } from "../src/digest/facts.ts";
import { generateDigest } from "../src/digest/generate.ts";
import { renderDigest } from "../src/digest/render.ts";

const args = process.argv.slice(2);
const weekArg = args.indexOf("--week");
const week = weekArg !== -1 ? Number(args[weekArg + 1]) : undefined;
const send = args.includes("--send");

console.error(`Gathering facts${week ? ` for week ${week}` : ""}…`);
const facts = await gatherWeekFacts(week);
console.error(
  `Week ${facts.week}: ${facts.results.length} matchups, ` +
    `${facts.bench_points.length} rosters, ` +
    `worst start/sit: ${facts.worst_start_sit ? `${facts.worst_start_sit.team} (${facts.worst_start_sit.delta} pts)` : "none"}`,
);

console.error("Generating digest…");
const digest = await generateDigest(facts);
const text = renderDigest(facts, digest);

console.log(`\n${text}\n`);

if (send) {
  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  if (!chatId) throw new Error("Set TELEGRAM_CHAT_ID in .env to use --send.");
  const { sendMessage } = await import("../src/telegram/bot.ts");
  await sendMessage(chatId, text);
  console.error(`Sent to Telegram chat ${chatId}.`);
}
