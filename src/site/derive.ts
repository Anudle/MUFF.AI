/**
 * MUFF-71 — the pure half of the league site: raw weekly scores in, season
 * snapshot out. Same split as the digest (facts.ts): season.ts fetches, this
 * file computes, and every number on the page that isn't a simulation comes
 * from here — the browser draws, it doesn't do arithmetic.
 */

import { PLAYOFF_TEAMS, REGULAR_SEASON_END } from "./config.ts";
import type { SeasonInputs, SeasonSnapshot, TeamSeason } from "./types.ts";

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
    };
  });

  // swap[i][j]: team i's scores against team j's opponents. In the week j
  // played i, i can't play itself — it plays j instead.
  const swapRaw = inputs.teams.map((_, i) =>
    inputs.teams.map((_, j) =>
      scores.reduce((sum, s, w) => {
        const opp = opponent[w][j] === i ? j : opponent[w][j];
        return sum + (i === j ? outcome(s[i], s[opponent[w][i]]) : outcome(s[i], s[opp]));
      }, 0),
    ),
  );

  // Standing order: wins (ties half), then points for.
  const order = built
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.wins + b.t.ties / 2 - (a.t.wins + a.t.ties / 2) || b.t.points_for - a.t.points_for)
    .map((x) => x.i);
  const rank = new Map(order.map((orig, pos) => [orig, pos]));

  return {
    league: inputs.league,
    season: inputs.season,
    through_week: inputs.played.at(-1)?.week ?? 0,
    generated_at: generatedAt,
    config: { regular_season_end: REGULAR_SEASON_END, playoff_teams: PLAYOFF_TEAMS },
    teams: order.map((i) => built[i]),
    swap: order.map((i) => order.map((j) => swapRaw[i][j])),
    remaining: inputs.remaining.map((wk) => ({
      week: wk.week,
      matchups: wk.matchups.map((m) => {
        if (m.length !== 2) throw new Error(`Week ${wk.week}: a scheduled matchup has ${m.length} teams, expected 2.`);
        return [rank.get(at(m[0], wk.week))!, rank.get(at(m[1], wk.week))!] as [number, number];
      }),
    })),
  };
}
