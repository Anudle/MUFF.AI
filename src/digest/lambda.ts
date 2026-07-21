/**
 * MUFF-43 — scheduled digest Lambda.
 *
 * EventBridge Scheduler invokes this every Tuesday morning (America/Denver)
 * during the season with the payload {} — which means "last completed week,
 * deliver to Telegram". For manual testing you can invoke with:
 *
 *   {"week": 15}                → specific week, still delivers
 *   {"dry_run": true}           → full pipeline (incl. rankings persist),
 *                                 returns the text instead of sending it
 *
 * Failures are NOT swallowed: a thrown error marks the invocation failed in
 * CloudWatch, which is the observable signal that a Tuesday digest didn't
 * go out. (Alerting on that is MUFF-16's business.)
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
  return {
    season: result.season,
    week: result.week,
    delivered: result.sent_to !== null,
    chars: result.text.length,
  };
}
