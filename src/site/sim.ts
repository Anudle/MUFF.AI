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
 * Standing order (rankTeams, the one comparator the odds, the bracket and
 * derive.ts all use): wins (a tie is half a win), then head-to-head among the
 * teams tied on record, then points for. Head-to-head is docs/league-rules.md's
 * seeding tiebreak; Anu confirmed on 2026-11-23 that it comes first and points
 * for is the fallback.
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

/**
 * Sort team indexes into standing order, in place. `h2h` is a flat n×n
 * matrix: h2h[a * n + b] = games a has won against b (a tie is half each).
 *
 * Teams level on record are split by their net head-to-head result in games
 * among just those teams (wins minus losses, so a team that has not played
 * the others sits at zero), then by points for. A tie of three or more is
 * ranked in one pass — it is not re-broken after the first team is placed.
 */
export function rankTeams(
  order: number[],
  wins: ArrayLike<number>,
  pf: ArrayLike<number>,
  h2h: ArrayLike<number>,
  n: number,
): void {
  order.sort((x, y) => wins[y] - wins[x] || pf[y] - pf[x] || x - y);
  for (let s = 0; s < order.length; ) {
    let e = s + 1;
    while (e < order.length && wins[order[e]] === wins[order[s]]) e++;
    if (e - s > 1) {
      const group = order.slice(s, e);
      const net = new Map<number, number>();
      let any = false;
      for (const i of group) {
        let v = 0;
        for (const j of group) if (j !== i) v += h2h[i * n + j] - h2h[j * n + i];
        if (v !== 0) any = true;
        net.set(i, v);
      }
      if (any) {
        group.sort((x, y) => net.get(y)! - net.get(x)! || pf[y] - pf[x] || x - y);
        for (let k = 0; k < group.length; k++) order[s + k] = group[k];
      }
    }
    s = e;
  }
}

/** The snapshot's head-to-head matrix, flattened; zeros when the snapshot has none. */
function flatH2h(snapshot: SeasonSnapshot): Float64Array {
  const n = snapshot.teams.length;
  const flat = new Float64Array(n * n);
  snapshot.h2h?.forEach((row, a) => row.forEach((v, b) => (flat[a * n + b] = v)));
  return flat;
}

export interface Seeding {
  /** Team indexes in seed order: order[0] is the top seed. */
  order: number[];
  /** Records with the picks applied, by team index. */
  wins: number[];
  losses: number[];
  ties: number[];
  /** Remaining games with no pick; they are left out, not guessed. */
  unpicked: number;
}

/**
 * The bracket's seeding: today's standings plus the picked results, nothing
 * simulated. A picked game adds a win, a loss and a head-to-head result but
 * no points, so points-for tiebreaks use the totals as they stand today.
 */
export function seedings(snapshot: SeasonSnapshot, picks: Picks = {}): Seeding {
  const teams = snapshot.teams;
  const n = teams.length;
  const wins = teams.map((t) => t.wins);
  const losses = teams.map((t) => t.losses);
  const ties = teams.map((t) => t.ties);
  const h2h = flatH2h(snapshot);
  let unpicked = 0;
  for (const wk of snapshot.remaining) {
    wk.matchups.forEach(([a, b], m) => {
      const w = picks[pickKey(wk.week, m)];
      if (w !== a && w !== b) {
        unpicked++;
        return;
      }
      const l = w === a ? b : a;
      wins[w]++;
      losses[l]++;
      h2h[w * n + l] += 1;
    });
  }
  const order = teams.map((_, i) => i);
  rankTeams(order, wins.map((w, i) => w + ties[i] / 2), teams.map((t) => t.points_for), h2h, n);
  return { order, wins, losses, ties, unpicked };
}

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
  const baseH2h = flatH2h(snapshot);
  const h2h = new Float64Array(n * n);

  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < n; i++) {
      wins[i] = baseWins[i];
      pf[i] = basePf[i];
    }
    h2h.set(baseH2h);
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
      if (sa > sb) {
        wins[g.a] += 1;
        h2h[g.a * n + g.b] += 1;
      } else if (sb > sa) {
        wins[g.b] += 1;
        h2h[g.b * n + g.a] += 1;
      } else {
        wins[g.a] += 0.5;
        wins[g.b] += 0.5;
        h2h[g.a * n + g.b] += 0.5;
        h2h[g.b * n + g.a] += 0.5;
      }
    }
    rankTeams(order, wins, pf, h2h, n);
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
