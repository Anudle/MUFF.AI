/**
 * MUFF-71 — the pure half of the league site: raw weekly scores in, season
 * snapshot out. Same split as the digest (facts.ts): season.ts fetches, this
 * file computes, and every number on the page that isn't a simulation comes
 * from here — the browser draws, it doesn't do arithmetic.
 */

import type { Digest } from "../digest/generate.ts";
import { teamKey } from "../digest/team-names.ts";
import { PLAYOFF_TEAMS, REGULAR_SEASON_END } from "./config.ts";
import { rankTeams } from "./sim.ts";
import type { SeasonInputs, SeasonSnapshot, SiteDigest, TeamSeason } from "./types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 1 for a win, 0.5 for a tie, 0 for a loss. */
const outcome = (mine: number, theirs: number) => (mine > theirs ? 1 : mine === theirs ? 0.5 : 0);

export function deriveSeason(inputs: SeasonInputs, generatedAt = new Date().toISOString()): SeasonSnapshot {
  const n = inputs.teams.length;
  const index = new Map(inputs.teams.map((t, i) => [t.name, i]));
  const at = (name: string, week: number): number => {
    const i = index.get(name);
    if (i === undefined) throw new Error(`Week ${week}: "${name}" is not a team in ${inputs.league}.`);
    return i;
  };

  // scores[w][i] and opponent[w][i], by input team order.
  const scores: number[][] = [];
  const opponent: number[][] = [];
  for (const wk of inputs.played) {
    const s = new Array<number>(n).fill(NaN);
    const o = new Array<number>(n).fill(-1);
    for (const m of wk.matchups) {
      if (m.length !== 2) throw new Error(`Week ${wk.week}: a matchup has ${m.length} teams, expected 2.`);
      const [a, b] = [at(m[0].team, wk.week), at(m[1].team, wk.week)];
      s[a] = m[0].points;
      s[b] = m[1].points;
      o[a] = b;
      o[b] = a;
    }
    if (o.includes(-1)) throw new Error(`Week ${wk.week}: not every team has a matchup.`);
    scores.push(s);
    opponent.push(o);
  }

  const built: TeamSeason[] = inputs.teams.map((t, i) => {
    let wins = 0, losses = 0, ties = 0, apW = 0, apL = 0, apT = 0, expected = 0;
    scores.forEach((s, w) => {
      const r = outcome(s[i], s[opponent[w][i]]);
      if (r === 1) wins++;
      else if (r === 0) losses++;
      else ties++;
      let wkW = 0, wkT = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (s[i] > s[j]) wkW++;
        else if (s[i] === s[j]) wkT++;
      }
      apW += wkW;
      apT += wkT;
      apL += n - 1 - wkW - wkT;
      expected += (wkW + wkT / 2) / (n - 1);
    });
    return {
      team: t.name,
      manager: t.manager,
      wins,
      losses,
      ties,
      points_for: round2(scores.reduce((sum, s) => sum + s[i], 0)),
      scores: scores.map((s) => s[i]),
      all_play: { wins: apW, losses: apL, ties: apT },
      expected_wins: round2(expected),
      luck: round2(wins + ties / 2 - expected),
      road: null as TeamSeason["road"],
    };
  });

  // Standing order: wins (ties half), then points for — the same comparator
  // the simulation and the bracket use (sim.ts), and Yahoo's standings order.
  const order = built.map((_, i) => i);
  rankTeams(order, built.map((t) => t.wins + t.ties / 2), built.map((t) => t.points_for));
  const rank = new Map(order.map((orig, pos) => [orig, pos]));

  const teams = order.map((i) => built[i]);
  const remaining = inputs.remaining.map((wk) => ({
    week: wk.week,
    matchups: wk.matchups.map((m) => {
      if (m.length !== 2) throw new Error(`Week ${wk.week}: a scheduled matchup has ${m.length} teams, expected 2.`);
      return [rank.get(at(m[0], wk.week))!, rank.get(at(m[1], wk.week))!] as [number, number];
    }),
  }));

  // The run-in: how much each team's remaining opponents score, against the
  // league's average points per game. An opponent faced twice counts twice.
  const games = scores.length;
  const ppg = teams.map((t) => (games ? t.points_for / games : 0));
  const leaguePpg = ppg.reduce((sum, v) => sum + v, 0) / (ppg.length || 1);
  const faced: number[][] = teams.map(() => []);
  for (const wk of remaining) {
    for (const [a, b] of wk.matchups) {
      faced[a].push(ppg[b]);
      faced[b].push(ppg[a]);
    }
  }
  teams.forEach((t, i) => {
    if (!games || faced[i].length === 0) return;
    const oppAvg = faced[i].reduce((sum, v) => sum + v, 0) / faced[i].length;
    t.road = { opp_avg: round2(oppAvg), vs_league: round2(oppAvg - leaguePpg) };
  });

  return {
    league: inputs.league,
    season: inputs.season,
    through_week: inputs.played.at(-1)?.week ?? 0,
    generated_at: generatedAt,
    config: { regular_season_end: REGULAR_SEASON_END, playoff_teams: PLAYOFF_TEAMS },
    teams,
    remaining,
  };
}

/**
 * The published digest in the shape the page draws. The previous rank is
 * looked up here, by team key (week-1 history predates canonical names), so
 * the page's arrows are computed in code like the chat message's.
 */
export function toSiteDigest(
  week: number,
  digest: Digest,
  previous: { rank: number; team: string }[] | null,
): SiteDigest {
  const was = new Map((previous ?? []).map((p) => [teamKey(p.team), p.rank]));
  return {
    week,
    headline: digest.headline,
    recap: digest.recap,
    power_rankings: [...digest.power_rankings]
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({ rank: p.rank, team: p.team, comment: p.comment, prev_rank: was.get(teamKey(p.team)) ?? null })),
  };
}
