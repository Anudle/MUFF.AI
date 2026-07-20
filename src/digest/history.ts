/**
 * MUFF-38 — persisted digest state across weekly runs.
 *
 * Power-ranking arrows need what was PUBLISHED last week — regenerating
 * week N-1 on the fly could rank differently and the arrows would lie.
 * So each run persists its rankings; the next run reads them. Local JSON
 * for now; the Lambda (MUFF-39) moves this to S3/DynamoDB.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(process.cwd(), "data", "digest-history.json");

interface History {
  power_rankings: Record<string, { rank: number; team: string }[]>; // "season:week"
}

function load(): History {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { power_rankings: {} };
  }
}

export function loadPowerRankings(
  season: string,
  week: number,
): { rank: number; team: string }[] | null {
  return load().power_rankings[`${season}:${week}`] ?? null;
}

export function savePowerRankings(
  season: string,
  week: number,
  rankings: { rank: number; team: string }[],
): void {
  const history = load();
  history.power_rankings[`${season}:${week}`] = rankings.map(({ rank, team }) => ({ rank, team }));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(history, null, 1) + "\n");
}
