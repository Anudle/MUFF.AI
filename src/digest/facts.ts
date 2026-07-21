/**
 * MUFF-38 — deterministic fact derivation for the weekly digest.
 *
 * The grounding rule that makes the digest better than last season's generic
 * insult bot: EVERY number the model jokes about is computed HERE, in code,
 * from Yahoo data. The model receives finished facts and writes prose around
 * them — it never does arithmetic and never sees raw rosters it could
 * misread. (CCA-F: this is the workflow half of the workflow-vs-agent
 * decision — fixed steps, deterministic code; see docs/digest-design.md.)
 */

import {
  getLeagueRosters,
  getStandings,
  getTransactions,
  getWeekResults,
  resolveLeague,
} from "../mcp/yahoo-data.ts";
import { loadPowerRankings } from "./history.ts";

// Slots that score points. Everything else (BN, IR) rides the pine.
const isStarter = (slot: string | null) => slot !== null && slot !== "BN" && slot !== "IR";

/** Can `position` legally fill `slot`? (Yahoo NFL slots.) */
function fits(position: string | null, slot: string | null): boolean {
  if (!position || !slot) return false;
  const positions = position.split(","); // e.g. "RB,WR"
  if (positions.includes(slot)) return true;
  if (slot === "W/R/T") return positions.some((p) => ["WR", "RB", "TE"].includes(p));
  if (slot === "W/R") return positions.some((p) => ["WR", "RB"].includes(p));
  return false;
}

export interface WeekFacts {
  league: string;
  season: string;
  week: number;
  results: {
    winner: string | null;
    is_tied: boolean;
    teams: { team: string; manager: string | null; points: number | null; projected: number | null }[];
    margin: number | null;
  }[];
  highest_scorer: { team: string; points: number } | null;
  lowest_scorer: { team: string; points: number } | null;
  closest_game: { teams: string[]; margin: number } | null;
  biggest_blowout: { winner: string; loser: string; margin: number } | null;
  /** actual − projected, best and worst. */
  overachiever: { team: string; delta: number } | null;
  underachiever: { team: string; delta: number } | null;
  /** Points left on the bench, per team, worst first. */
  bench_points: { team: string; manager: string | null; bench_points: number }[];
  /**
   * Biggest single start/sit blunder league-wide: benched player who
   * outscored a started player he could legally have replaced.
   */
  worst_start_sit: {
    team: string;
    manager: string | null;
    benched: { name: string; points: number };
    started: { name: string; slot: string; points: number };
    delta: number;
    would_have_flipped_result: boolean;
  } | null;
  standings: {
    rank: number | null;
    team: string;
    manager: string | null;
    record: string;
    points_for: number | null;
    streak: string | null;
  }[];
  recent_transactions: { type: string | null; date: string | null; summary: string }[];
  /** The power rankings PUBLISHED in last week's digest (null in week 1 / cold start). */
  previous_power_rankings: { rank: number; team: string }[] | null;
}

export async function gatherWeekFacts(week?: number): Promise<WeekFacts> {
  const league = await resolveLeague();
  // For the Tuesday digest with no explicit week, recap the LAST completed
  // week: during the season Yahoo's current_week has already advanced by
  // Tuesday morning.
  const w =
    week ??
    (league.is_finished ? league.current_week : Math.max(league.start_week, league.current_week - 1));

  const [results, standings, transactions, rosters] = [
    await getWeekResults(w),
    await getStandings(),
    await getTransactions(15),
    await getLeagueRosters(w),
  ];

  // --- matchup-level facts ---------------------------------------------------
  const games = results.matchups.map((m) => {
    const pts = m.teams.map((t) => t.points).filter((p): p is number => p !== null);
    const margin = pts.length === 2 ? Math.abs(pts[0] - pts[1]) : null;
    return {
      winner: m.winner,
      is_tied: m.is_tied,
      teams: m.teams.map((t) => ({
        team: t.team ?? "?",
        manager: t.manager,
        points: t.points,
        projected: t.projected_points,
      })),
      margin,
    };
  });

  const scored = games.flatMap((g) => g.teams).filter((t) => t.points !== null);
  const byPoints = [...scored].sort((a, b) => b.points! - a.points!);
  const decided = games.filter((g) => g.margin !== null && !g.is_tied);
  const closest = [...decided].sort((a, b) => a.margin! - b.margin!)[0] ?? null;
  const blowout = [...decided].sort((a, b) => b.margin! - a.margin!)[0] ?? null;

  const deltas = scored
    .filter((t) => t.projected !== null)
    .map((t) => ({ team: t.team, delta: +(t.points! - t.projected!).toFixed(2) }))
    .sort((a, b) => b.delta - a.delta);

  // --- roster-level facts (bench points, start/sit) --------------------------
  const bench = rosters.teams
    .map((t) => ({
      team: t.team,
      manager: t.manager,
      bench_points: +t.players
        .filter((p) => p.slot === "BN")
        .reduce((sum, p) => sum + (p.points ?? 0), 0)
        .toFixed(2),
    }))
    .sort((a, b) => b.bench_points - a.bench_points);

  let worstStartSit: WeekFacts["worst_start_sit"] = null;
  for (const t of rosters.teams) {
    const starters = t.players.filter((p) => isStarter(p.slot));
    for (const b of t.players.filter((p) => p.slot === "BN" && p.points !== null)) {
      for (const s of starters) {
        if (s.points === null || !fits(b.position, s.slot)) continue;
        const delta = +(b.points! - s.points).toFixed(2);
        if (delta <= (worstStartSit?.delta ?? 0)) continue;
        const game = games.find((g) => g.teams.some((gt) => gt.team === t.team));
        const me = game?.teams.find((gt) => gt.team === t.team);
        const opp = game?.teams.find((gt) => gt.team !== t.team);
        const lost = !!game && game.winner !== null && game.winner !== t.team;
        const flips =
          lost && me?.points != null && opp?.points != null && me.points + delta > opp.points;
        worstStartSit = {
          team: t.team,
          manager: t.manager,
          benched: { name: b.name ?? "?", points: b.points! },
          started: { name: s.name ?? "?", slot: s.slot ?? "?", points: s.points },
          delta,
          would_have_flipped_result: flips,
        };
      }
    }
  }

  return {
    league: results.league,
    season: results.season,
    week: w,
    results: games,
    highest_scorer: byPoints[0] ? { team: byPoints[0].team, points: byPoints[0].points! } : null,
    lowest_scorer: byPoints.at(-1)
      ? { team: byPoints.at(-1)!.team, points: byPoints.at(-1)!.points! }
      : null,
    closest_game: closest
      ? { teams: closest.teams.map((t) => t.team), margin: closest.margin! }
      : null,
    biggest_blowout:
      blowout && blowout.winner
        ? {
            winner: blowout.winner,
            loser: blowout.teams.find((t) => t.team !== blowout.winner)?.team ?? "?",
            margin: blowout.margin!,
          }
        : null,
    overachiever: deltas[0] ?? null,
    underachiever: deltas.at(-1) ?? null,
    bench_points: bench,
    worst_start_sit: worstStartSit,
    standings: standings.standings.map((s) => ({
      rank: s.rank,
      team: s.team ?? "?",
      manager: s.manager,
      record: `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ""}`,
      points_for: s.points_for,
      streak: s.streak,
    })),
    previous_power_rankings: await loadPowerRankings(results.season, w - 1),
    recent_transactions: transactions.transactions.slice(0, 10).map((t) => ({
      type: t.type,
      date: t.date,
      summary: t.players
        .map((p) => `${p.name} (${p.position}) ${p.action}: ${p.from ?? "?"} → ${p.to ?? "?"}`)
        .join("; "),
    })),
  };
}
