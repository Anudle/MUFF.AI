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

import { archiveRun, type GateResult } from "./archive.ts";
import { addCosts, type RunCost } from "./cost.ts";
import { evaluateRecord } from "../eval/checks.ts";
import type { Provenance } from "../mcp/provider.ts";
import { gatherWeekFacts } from "./facts.ts";
import { generateDigest } from "./generate.ts";
import { savePowerRankings } from "./history.ts";
import { renderDigest } from "./render.ts";

/**
 * Progress lines. Locally they go to stderr so stdout stays the digest text
 * (scripts/digest.ts prints it there); on Lambda, console.error would tag
 * every line ERROR in CloudWatch and drown the one signal that matters — a
 * failed invocation — so they log at INFO instead.
 */
const progress = process.env.AWS_LAMBDA_FUNCTION_NAME ? console.info : console.error;

/** How many times the model may be asked for a week before we ship what we have. */
const MAX_GENERATIONS = 2;

export interface DigestRunResult {
  run_id: string;
  season: string;
  week: number;
  text: string;
  /** Inline rule-gate verdict: did the shipped digest pass, and how many generations it took. */
  gate: GateResult;
  sent_to: number | null;
  cost: RunCost;
  duration_ms: number;
  /** Archive key, or null if the archive write failed (non-fatal). */
  archived: string | null;
  /** Where the week's numbers came from (MUFF-58) — surfaced for the log line. */
  provenance: Provenance;
}

export async function runDigest(opts: {
  week?: number;
  send: boolean;
}): Promise<DigestRunResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();

  progress(`Gathering facts${opts.week ? ` for week ${opts.week}` : ""}…`);
  const facts = await gatherWeekFacts(opts.week);
  progress(
    `Week ${facts.week}: ${facts.results.length} matchups, ` +
      `${facts.bench_points.length} rosters, ` +
      `worst start/sit: ${facts.worst_start_sit ? `${facts.worst_start_sit.team} (${facts.worst_start_sit.delta} pts)` : "none"}`,
  );

  // The rule gate (src/eval/checks.ts) runs inline, not just in CI: a digest
  // that fails it is regenerated once (MUFF-60 punch list #1). Second attempt
  // ships regardless — a slightly-off digest beats a missed Tuesday, and the
  // archive records both verdicts so the eval can see what happened.
  let digest, cost, text;
  const attempts: GateResult["attempts"] = [];
  for (let attempt = 1; ; attempt++) {
    progress(attempt === 1 ? "Generating digest…" : `Gate failed — regenerating (attempt ${attempt}/${MAX_GENERATIONS})…`);
    const generated = await generateDigest(facts);
    const t = renderDigest(facts, generated.digest);
    const report = evaluateRecord({ facts, digest: generated.digest, text: t });
    attempts.push({ pass: report.pass, failed: report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`) });
    cost = cost ? addCosts(cost, generated.cost) : generated.cost;
    digest = generated.digest;
    text = t;
    if (report.pass || attempt >= MAX_GENERATIONS) break;
    progress(`  ${attempts[attempts.length - 1].failed.join("\n  ")}`);
  }
  const gate: GateResult = { pass: attempts[attempts.length - 1].pass, attempts };

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
    gate,
  });

  let sentTo: number | null = null;
  if (opts.send) {
    const chatId = Number(process.env.TELEGRAM_CHAT_ID);
    if (!chatId) throw new Error("Set TELEGRAM_CHAT_ID to deliver the digest.");
    const { sendMessage } = await import("../telegram/bot.ts");
    await sendMessage(chatId, text);
    progress(`Sent to Telegram chat ${chatId}.`);
    sentTo = chatId;
  }

  return {
    run_id: runId,
    season: facts.season,
    week: facts.week,
    text,
    gate,
    sent_to: sentTo,
    cost,
    duration_ms: durationMs,
    archived,
    provenance: facts.provenance,
  };
}
