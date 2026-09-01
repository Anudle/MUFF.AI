/**
 * MUFF-16 — every digest run, kept.
 *
 * A run archive is the difference between "the bot ran all season" and "here
 * are 18 runs, scored, with cost". Each record holds the exact model INPUT
 * (facts), the exact model OUTPUT (parsed digest), the rendered message, and
 * what it cost — which is everything the eval harness needs later:
 *
 *   - groundedness scoring reads facts + digest together (does every number
 *     in the trash talk appear in the facts?)
 *   - regression detection re-runs a frozen `facts` through a new prompt and
 *     diffs against the archived digest
 *   - cost tracking sums `cost` across the season
 *
 * Archiving is deliberately NOT fatal: a failed S3 write must never cost the
 * league its Tuesday digest. The message is the product; the archive is
 * evidence. Losing evidence is loud (a logged error) but not breaking.
 */

import type { Digest } from "./generate.ts";
import type { WeekFacts } from "./facts.ts";
import type { RunCost } from "./cost.ts";
import { store } from "../store.ts";

export const RUNS_PREFIX = "runs";

export interface RunRecord {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  season: string;
  week: number;
  /** Delivery was attempted — the archive is written before the send. */
  delivery_attempted: boolean;
  cost: RunCost;
  facts: WeekFacts;
  digest: Digest;
  text: string;
}

/** `runs/2025-w07-20260915T130004Z.json` — sorts chronologically, week zero-padded. */
export function runKey(season: string, week: number, finishedAt: string): string {
  const stamp = finishedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${RUNS_PREFIX}/${season}-w${String(week).padStart(2, "0")}-${stamp}.json`;
}

/** Returns the archived key, or null if archiving failed (never throws). */
export async function archiveRun(record: RunRecord): Promise<string | null> {
  const key = runKey(record.season, record.week, record.finished_at);
  try {
    await store.write(key, record);
    return key;
  } catch (e) {
    console.error(`Archive write failed for ${key}: ${(e as Error).message}`);
    return null;
  }
}

export async function listRuns(): Promise<string[]> {
  return store.list(RUNS_PREFIX);
}

export async function loadRun(key: string): Promise<RunRecord | null> {
  return store.read<RunRecord>(key);
}
