/**
 * MUFF-43 — the digest pipeline as one reusable function.
 *
 * gather → generate → render → persist rankings → archive → (optionally) deliver.
 * Callers: scripts/digest.ts (CLI, dry-run by default) and
 * src/digest/lambda.ts (EventBridge Scheduler, sends by default).
 *
 * MUFF-16 added the archive step and the cost on the result. Ordering matters:
 * delivery happens LAST, after everything that could throw. A run that sends
 * the digest and then dies has already done its job; a run that archives and
 * then dies has sent nothing, and the league notices that.
 */

import { archiveRun } from "./archive.ts";
import type { RunCost } from "./cost.ts";
import { gatherWeekFacts } from "./facts.ts";
import { generateDigest } from "./generate.ts";
import { savePowerRankings } from "./history.ts";
import { renderDigest } from "./render.ts";

export interface DigestRunResult {
  run_id: string;
  season: string;
  week: number;
  text: string;
  sent_to: number | null;
  cost: RunCost;
  duration_ms: number;
  /** Archive key, or null if the archive write failed (non-fatal). */
  archived: string | null;
}

export async function runDigest(opts: {
  week?: number;
  send: boolean;
}): Promise<DigestRunResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();

  console.error(`Gathering facts${opts.week ? ` for week ${opts.week}` : ""}…`);
  const facts = await gatherWeekFacts(opts.week);
  console.error(
    `Week ${facts.week}: ${facts.results.length} matchups, ` +
      `${facts.bench_points.length} rosters, ` +
      `worst start/sit: ${facts.worst_start_sit ? `${facts.worst_start_sit.team} (${facts.worst_start_sit.delta} pts)` : "none"}`,
  );

  console.error("Generating digest…");
  const { digest, cost } = await generateDigest(facts);
  const text = renderDigest(facts, digest);

  // Persist this week's rankings so next week's digest can show movement.
  // (Re-running a week overwrites its entry — latest run is what "published" means.)
  await savePowerRankings(facts.season, facts.week, digest.power_rankings);

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  // Archive BEFORE sending: the record says whether delivery was attempted,
  // and a dry run is just as much evidence as a delivered one.
  const archived = await archiveRun({
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    season: facts.season,
    week: facts.week,
    delivery_attempted: opts.send,
    cost,
    facts,
    digest,
    text,
  });

  let sentTo: number | null = null;
  if (opts.send) {
    const chatId = Number(process.env.TELEGRAM_CHAT_ID);
    if (!chatId) throw new Error("Set TELEGRAM_CHAT_ID to deliver the digest.");
    const { sendMessage } = await import("../telegram/bot.ts");
    await sendMessage(chatId, text);
    console.error(`Sent to Telegram chat ${chatId}.`);
    sentTo = chatId;
  }

  return {
    run_id: runId,
    season: facts.season,
    week: facts.week,
    text,
    sent_to: sentTo,
    cost,
    duration_ms: durationMs,
    archived,
  };
}
