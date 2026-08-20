/**
 * MUFF-43 — scheduled digest Lambda.
 *
 * EventBridge Scheduler invokes this every Tuesday morning (America/Denver)
 * during the season with the payload {} — which means "last completed week,
 * deliver to Telegram". For manual testing you can invoke with:
 *
 *   {"week": 15}                → specific week, still delivers
 *   {"dry_run": true}           → full pipeline (incl. rankings persist and
 *                                 archive), returns the text instead of sending
 *
 * Failures are NOT swallowed: a thrown error marks the invocation failed in
 * CloudWatch, which is the observable signal that a Tuesday digest didn't
 * go out.
 *
 * MUFF-16 adds one structured log line per run, tagged MUFF_RUN so a Logs
 * Insights query can pull a season of cost data out of CloudWatch without
 * touching S3:
 *
 *   fields @timestamp, week, cost_usd, duration_ms, delivered
 *   | filter tag = "MUFF_RUN"
 *   | sort @timestamp asc
 */

import { runDigest } from "./run.ts";

interface DigestEvent {
  week?: number;
  dry_run?: boolean;
}

export async function handler(event: DigestEvent | null | undefined) {
  const { week, dry_run = false } = event ?? {};
  const result = await runDigest({ week, send: !dry_run });

  // The rendered text lands in CloudWatch either way — cheap audit trail.
  console.log(result.text);

  // One machine-readable line per run. JSON.stringify keeps it a single log
  // event, which is what makes it queryable — a multi-line dump is not.
  const summary = {
    tag: "MUFF_RUN",
    run_id: result.run_id,
    season: result.season,
    week: result.week,
    delivered: result.sent_to !== null,
    duration_ms: result.duration_ms,
    chars: result.text.length,
    archived: result.archived,
    cost_usd: result.cost.cost_usd,
    model: result.cost.model,
    input_tokens: result.cost.input_tokens,
    output_tokens: result.cost.output_tokens,
  };
  console.log(JSON.stringify(summary));

  return summary;
}
