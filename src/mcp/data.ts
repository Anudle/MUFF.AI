/**
 * MUFF-49 — provider selection. The ONLY place that knows more than one
 * fantasy backend exists.
 *
 * FANTASY_PROVIDER=yahoo|sleeper|fixture (default yahoo) picks the data
 * layer at startup; everything above this line — MCP tools, digest facts,
 * evals — imports from here and is provider-blind. The swap being
 * config-only is the MUFF-49 acceptance criterion.
 *
 * `fixture` (MUFF-58) is the human-in-the-loop provider: hand-transcribed
 * weeks read from the blob store. It is a first-class value here, not a
 * fallthrough — an unknown value still means yahoo, never silently manual.
 */

import * as yahoo from "./yahoo-data.ts";
import * as sleeper from "./sleeper-data.ts";
import * as fixture from "./fixture-data.ts";
import type { Provenance } from "./provider.ts";

export type ProviderName = "yahoo" | "sleeper" | "fixture";

export const PROVIDER: ProviderName =
  process.env.FANTASY_PROVIDER === "sleeper"
    ? "sleeper"
    : process.env.FANTASY_PROVIDER === "fixture"
      ? "fixture"
      : "yahoo";

// Typed as the Yahoo module: its signatures ARE the provider contract, so
// this line is also the compile-time proof that sleeper-data and
// fixture-data implement it.
const provider: typeof yahoo =
  PROVIDER === "sleeper" ? sleeper : PROVIDER === "fixture" ? fixture : yahoo;

/**
 * Provenance of a week's data. API providers are their own source; the
 * fixture provider reports who transcribed the week and when it was uploaded.
 */
export async function getProvenance(week: number): Promise<Provenance> {
  if (PROVIDER === "fixture") return fixture.getProvenance(week);
  return { source: PROVIDER, ingested_by: null, ingested_at: null };
}

export const resolveLeague = provider.resolveLeague;
export const getRoster = provider.getRoster;
export const getLeagueRosters = provider.getLeagueRosters;
export const getMatchup = provider.getMatchup;
export const getStandings = provider.getStandings;
export const getTransactions = provider.getTransactions;
export const getWeekResults = provider.getWeekResults;
