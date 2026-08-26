/**
 * MUFF-49 — provider selection. The ONLY place that knows more than one
 * fantasy backend exists.
 *
 * FANTASY_PROVIDER=sleeper|yahoo (default yahoo) picks the data layer at
 * startup; everything above this line — MCP tools, digest facts, evals —
 * imports from here and is provider-blind. The swap being config-only is
 * the MUFF-49 acceptance criterion.
 */

import * as yahoo from "./yahoo-data.ts";
import * as sleeper from "./sleeper-data.ts";

export const PROVIDER =
  process.env.FANTASY_PROVIDER === "sleeper" ? "sleeper" : "yahoo";

// Typed as the Yahoo module: its signatures ARE the provider contract, so
// this line is also the compile-time proof that sleeper-data implements it.
const provider: typeof yahoo = PROVIDER === "sleeper" ? sleeper : yahoo;

export const resolveLeague = provider.resolveLeague;
export const getRoster = provider.getRoster;
export const getLeagueRosters = provider.getLeagueRosters;
export const getMatchup = provider.getMatchup;
export const getStandings = provider.getStandings;
export const getTransactions = provider.getTransactions;
export const getWeekResults = provider.getWeekResults;
