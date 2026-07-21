/**
 * MUFF-43 — the digest pipeline as one reusable function.
 *
 * gather → generate → render → persist rankings → (optionally) deliver.
 * Callers: scripts/digest.ts (CLI, dry-run by default) and
 * src/digest/lambda.ts (EventBridge Scheduler, sends by default).
 */

import { gatherWeekFacts } from "./facts.ts";
import { generateDigest } from "./generate.ts";
import { savePowerRankings } from "./history.ts";
import { renderDigest } from "./render.ts";

export interface DigestRunResult {
  season: string;
  week: number;
  text: string;
  sent_to: number | null;
}

export async function runDigest(opts: {
  week?: number;
  send: boolean;
}): Promise<DigestRunResult> {
  console.error(`Gathering facts${opts.week ? ` for week ${opts.week}` : ""}…`);
  const facts = await gatherWeekFacts(opts.week);
  console.error(
    `Week ${facts.week}: ${facts.results.length} matchups, ` +
      `${facts.bench_points.length} rosters, ` +
      `worst start/sit: ${facts.worst_start_sit ? `${facts.worst_start_sit.team} (${facts.worst_start_sit.delta} pts)` : "none"}`,
  );

  console.error("Generating digest…");
  const digest = await generateDigest(facts);
  const text = renderDigest(facts, digest);

  // Persist this week's rankings so next week's digest can show movement.
  // (Re-running a week overwrites its entry — latest run is what "published" means.)
  await savePowerRankings(facts.season, facts.week, digest.power_rankings);

  let sentTo: number | null = null;
  if (opts.send) {
    const chatId = Number(process.env.TELEGRAM_CHAT_ID);
    if (!chatId) throw new Error("Set TELEGRAM_CHAT_ID to deliver the digest.");
    const { sendMessage } = await import("../telegram/bot.ts");
    await sendMessage(chatId, text);
    console.error(`Sent to Telegram chat ${chatId}.`);
    sentTo = chatId;
  }

  return { season: facts.season, week: facts.week, text, sent_to: sentTo };
}
