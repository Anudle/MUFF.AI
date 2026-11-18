/**
 * MUFF-71 — playoff odds by simulation. This is the one piece of site
 * arithmetic that runs in the BROWSER: the what-if picker re-simulates on
 * every tap, and a round trip to a server for that would mean running a
 * server. So this file must stay import-free (types aside) and deterministic
 * for a given seed — the same module is unit-tested under node:test.
 *
 * Model, deliberately simple: each remaining score is a normal draw around
 * the team's season average (pulled toward the league average, because ten
 * games is a small sample) with the league's typical week-to-week spread.
 * It knows nothing about injuries, byes or rosters — it is "if everyone
 * keeps scoring like they have", not a projection.
 *
 * Qualification order: wins (a tie is half a win), then points for.
 * docs/league-rules.md only defines a head-to-head tiebreak for SEEDING and
 * says nothing about who gets in on a tied record; points-for is Yahoo's
 * default and is stated on the page.
 */

import type { SeasonSnapshot } from "./types.ts";

/** Forced winners: key `${week}:${matchupIndex}` → index into snapshot.teams. */
export type Picks = Record<string, number>;

export interface TeamOdds {
  /** Share of simulations in which the team finishes inside the playoff line. */
  playoff: number;
  /** Mean final regular-season wins (ties half). */
  avg_wins: number;
  /** Mean final standing, 1 = top seed. */
  avg_seed: number;
}

/** Games of evidence the league average is worth when estimating a team's true mean. */
const SHRINK_GAMES = 3;

/** mulberry32 — small seeded PRNG, so a page load and a test agree. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pickKey = (week: number, matchup: number) => `${week}:${matchup}`;

export function simulate(
  snapshot: SeasonSnapshot,
  picks: Picks = {},
  opts: { runs?: number; seed?: number } = {},
): TeamOdds[] {
  const runs = opts.runs ?? 10000;
  const rand = prng(opts.seed ?? 71);
  const teams = snapshot.teams;
  const n = teams.length;

  // Scoring model inputs.
  const all = teams.flatMap((t) => t.scores);
  const leagueMean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  let ss = 0, df = 0;
  for (const t of teams) {
    if (t.scores.length < 2) continue;
    const m = t.scores.reduce((a, b) => a + b, 0) / t.scores.length;
    for (const s of t.scores) ss += (s - m) ** 2;
    df += t.scores.length - 1;
  }
  const sd = df > 0 ? Math.sqrt(ss / df) : 0;
  const mean = teams.map((t) => {
    const g = t.scores.length;
    const sum = t.scores.reduce((a, b) => a + b, 0);
    return (sum + SHRINK_GAMES * leagueMean) / (g + SHRINK_GAMES);
  });
  const draw = (i: number) => {
    // Box–Muller; whole points, like the league's scoring.
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return Math.max(0, Math.round(mean[i] + sd * z));
  };

  const baseWins = teams.map((t) => t.wins + t.ties / 2);
  const basePf = teams.map((t) => t.points_for);
  const games = snapshot.remaining.flatMap((wk) =>
    wk.matchups.map(([a, b], m) => ({ a, b, forced: picks[pickKey(wk.week, m)] })),
  );

  const made = new Array<number>(n).fill(0);
  const winSum = new Array<number>(n).fill(0);
  const seedSum = new Array<number>(n).fill(0);
  const wins = new Array<number>(n);
  const pf = new Array<number>(n);
  const order = teams.map((_, i) => i);

  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < n; i++) {
      wins[i] = baseWins[i];
      pf[i] = basePf[i];
    }
    for (const g of games) {
      let sa = draw(g.a);
      let sb = draw(g.b);
      if (g.forced === g.a || g.forced === g.b) {
        // Condition on the picked result: the winner keeps the higher score.
        const hi = Math.max(sa, sb), lo = Math.min(sa, sb);
        const top = hi === lo ? hi + 1 : hi;
        sa = g.forced === g.a ? top : lo;
        sb = g.forced === g.b ? top : lo;
      }
      pf[g.a] += sa;
      pf[g.b] += sb;
      if (sa > sb) wins[g.a] += 1;
      else if (sb > sa) wins[g.b] += 1;
      else {
        wins[g.a] += 0.5;
        wins[g.b] += 0.5;
      }
    }
    order.sort((x, y) => wins[y] - wins[x] || pf[y] - pf[x] || x - y);
    for (let pos = 0; pos < n; pos++) {
      const i = order[pos];
      if (pos < snapshot.config.playoff_teams) made[i]++;
      winSum[i] += wins[i];
      seedSum[i] += pos + 1;
    }
  }

  return teams.map((_, i) => ({
    playoff: made[i] / runs,
    avg_wins: winSum[i] / runs,
    avg_seed: seedSum[i] / runs,
  }));
}
