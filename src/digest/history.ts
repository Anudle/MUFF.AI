/**
 * MUFF-38/43 — persisted digest state across weekly runs.
 *
 * Power-ranking arrows need what was PUBLISHED last week — regenerating
 * week N-1 on the fly could rank differently and the arrows would lie.
 * So each run persists its rankings; the next run reads them.
 *
 * The local-file-vs-S3 seam moved to store.ts in MUFF-16 (the run archive
 * needed the same one).
 */

import { store } from "../store.ts";

interface History {
  power_rankings: Record<string, { rank: number; team: string }[]>; // "season:week"
}

const KEY = process.env.HISTORY_KEY ?? "digest-history.json";

export async function loadPowerRankings(
  season: string,
  week: number,
): Promise<{ rank: number; team: string }[] | null> {
  const history = await store.read<History>(KEY);
  return history?.power_rankings[`${season}:${week}`] ?? null;
}

export async function savePowerRankings(
  season: string,
  week: number,
  rankings: { rank: number; team: string }[],
): Promise<void> {
  const history = (await store.read<History>(KEY)) ?? { power_rankings: {} };
  history.power_rankings[`${season}:${week}`] = rankings.map(({ rank, team }) => ({ rank, team }));
  await store.write(KEY, history);
}
