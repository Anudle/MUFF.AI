/**
 * MUFF-72 — the scout's arithmetic. Pure: inputs in, board out, no I/O and no
 * model. Same rule as the digest's facts: every number a human reads here was
 * computed in code.
 *
 * The comparison is deliberately simple. For each position, "my weakest
 * player" is the one with the fewest season points (the drop nobody would
 * miss), and every free agent is measured against him. A pickup earns a ping
 * only when the free agent had a real week AND clearly outscored that player.
 */

import {
  POSITIONS,
  type Candidate,
  type PoolPlayer,
  type Position,
  type RosterPlayer,
  type Scout,
  type ScoutInputs,
  type ScoutOptions,
} from "./types.ts";

/**
 * Standard scoring, whole points (docs/league-rules.md): 10 is a strong week
 * for a flex player. K and DEF swing on noise, so their bar is higher.
 */
export const DEFAULT_OPTIONS: ScoutOptions = {
  minPoints: { QB: 18, WR: 10, RB: 10, TE: 8, K: 12, DEF: 12 },
  minGain: 5,
  needSeasonLead: ["K", "DEF"],
  maxAlertsPerPosition: 3,
  boardSize: 10,
};

const plays = (p: PoolPlayer, position: Position) =>
  (p.position ?? "").split(",").includes(position);

const onBench = (p: RosterPlayer) => p.slot === "BN" || p.slot === "IR";

/** Fewest season points; then bench before starter; then the worse week. */
export function weakest(players: RosterPlayer[]): RosterPlayer | null {
  if (players.length === 0) return null;
  return [...players].sort(
    (a, b) =>
      (a.season_points ?? 0) - (b.season_points ?? 0) ||
      Number(onBench(b)) - Number(onBench(a)) ||
      (a.points ?? 0) - (b.points ?? 0),
  )[0];
}

export function deriveScout(
  inputs: ScoutInputs,
  options: ScoutOptions = DEFAULT_OPTIONS,
): Scout {
  const board = POSITIONS.map((position) => {
    const drop = weakest(inputs.roster.filter((p) => plays(p, position)));

    const candidates: Candidate[] = inputs.free_agents
      // No points reported means he has not played: nothing to compare yet.
      .filter((p) => plays(p, position) && p.points !== null && p.name !== null)
      .map((p) => {
        const points = p.points as number;
        const weekGain = points - (drop?.points ?? 0);
        const seasonGain =
          drop && p.season_points !== null && drop.season_points !== null
            ? p.season_points - drop.season_points
            : null;
        return {
          player_key: p.player_key,
          name: p.name as string,
          position,
          nfl_team: p.nfl_team,
          status: p.status,
          points,
          season_points: p.season_points,
          drop: drop?.name ?? null,
          drop_points: drop?.points ?? null,
          drop_season_points: drop?.season_points ?? null,
          week_gain: weekGain,
          season_gain: seasonGain,
          alert:
            points >= options.minPoints[position] &&
            weekGain >= options.minGain &&
            (!options.needSeasonLead.includes(position) || (seasonGain ?? 1) > 0),
        };
      })
      .sort(
        (a, b) =>
          b.points - a.points ||
          (b.season_points ?? 0) - (a.season_points ?? 0) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, options.boardSize);

    return { position, drop: drop?.name ?? null, candidates };
  });

  // A dual-position free agent sits on two boards; ping once, for the
  // position where he helps most.
  const best = new Map<string, Candidate>();
  const pings = board.flatMap((b) =>
    b.candidates
      .filter((c) => c.alert)
      .sort((x, y) => y.week_gain - x.week_gain || y.points - x.points)
      .slice(0, options.maxAlertsPerPosition),
  );
  for (const c of pings) {
    const seen = best.get(c.player_key);
    if (!seen || c.week_gain > seen.week_gain) best.set(c.player_key, c);
  }
  const alerts = [...best.values()].sort(
    (a, b) => b.week_gain - a.week_gain || b.points - a.points || a.name.localeCompare(b.name),
  );

  return {
    league: inputs.league,
    season: inputs.season,
    week: inputs.week,
    live: inputs.live,
    team: inputs.team,
    board,
    alerts,
  };
}

/** The alerts not yet sent this week (dedupe across repeated Sunday runs). */
export function newAlerts(alerts: Candidate[], alreadySent: string[]): Candidate[] {
  const sent = new Set(alreadySent);
  return alerts.filter((a) => !sent.has(a.player_key));
}
