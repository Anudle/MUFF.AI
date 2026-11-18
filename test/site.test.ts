/**
 * MUFF-71 — the league site's numbers. Pins the pure derive (all-play, luck,
 * schedule swap), the simulation's invariants (it is seeded, so these are
 * exact, not statistical), and publishSite's "never throws" promise to the
 * digest run.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { deriveSeason } from "../src/site/derive.ts";
import { pickKey, simulate } from "../src/site/sim.ts";
import type { SeasonInputs, SeasonSnapshot } from "../src/site/types.ts";

const game = (a: string, pa: number, b: string, pb: number) => [
  { team: a, points: pa },
  { team: b, points: pb },
];

/** Four teams, two weeks. D outscores two teams each week and still goes 0-2. */
const inputs: SeasonInputs = {
  league: "Test League",
  season: "2026",
  teams: ["A", "B", "C", "D"].map((name) => ({ name, manager: null })),
  played: [
    { week: 1, matchups: [game("A", 100, "B", 60), game("C", 50, "D", 40)] },
    { week: 2, matchups: [game("A", 90, "D", 80), game("B", 70, "C", 70)] },
  ],
  remaining: [{ week: 3, matchups: [["A", "C"], ["B", "D"]] }],
};
const snap = deriveSeason(inputs, "2026-11-17T00:00:00Z");
const byName = (s: SeasonSnapshot, name: string) => s.teams.find((t) => t.team === name)!;

test("deriveSeason: records, points and standing order (wins, ties half, then points for)", () => {
  assert.deepEqual(snap.teams.map((t) => t.team), ["A", "C", "B", "D"]);
  const c = byName(snap, "C");
  assert.deepEqual([c.wins, c.losses, c.ties, c.points_for], [1, 0, 1, 120]);
  assert.deepEqual(byName(snap, "D").scores, [40, 80]);
  assert.equal(snap.through_week, 2);
});

test("deriveSeason: all-play record counts every other team every week", () => {
  assert.deepEqual(byName(snap, "A").all_play, { wins: 6, losses: 0, ties: 0 });
  // Week 1 D is last (0-3); week 2 D beats B and C (2-1).
  assert.deepEqual(byName(snap, "D").all_play, { wins: 2, losses: 4, ties: 0 });
  // Week 2 B and C tie each other: one all-play tie apiece.
  assert.equal(byName(snap, "B").all_play.ties, 1);
  const total = snap.teams.reduce((s, t) => s + t.all_play.wins - t.all_play.losses, 0);
  assert.equal(total, 0, "all-play is zero-sum");
});

test("deriveSeason: luck is actual minus expected wins and nets to zero across the league", () => {
  const d = byName(snap, "D");
  assert.equal(d.expected_wins, 0.67); // 0/3 + 2/3
  assert.equal(d.luck, -0.67);
  assert.equal(byName(snap, "A").luck, 0); // 2 wins, expected 2
  const net = snap.teams.reduce((s, t) => s + t.luck, 0);
  assert.ok(Math.abs(net) < 0.05, `luck nets to ~0, got ${net}`);
});

test("deriveSeason: schedule swap — diagonal is the real record, off-diagonal replays the other schedule", () => {
  snap.teams.forEach((t, i) => assert.equal(snap.swap[i][i], t.wins + t.ties / 2));
  const i = (name: string) => snap.teams.findIndex((t) => t.team === name);
  // D with A's schedule: wk1 vs B (40<60 L), wk2 A's opponent is D itself, so D plays A (80<90 L).
  assert.equal(snap.swap[i("D")][i("A")], 0);
  // D with B's schedule: wk1 vs A (L), wk2 vs C (80>70 W).
  assert.equal(snap.swap[i("D")][i("B")], 1);
});

test("deriveSeason: remaining matchups are index pairs into the sorted teams", () => {
  const names = snap.remaining[0].matchups.map((m) => m.map((x) => snap.teams[x].team));
  assert.deepEqual(names, [["A", "C"], ["B", "D"]]);
});

test("deriveSeason: refuses a week where a team has no matchup, or an unknown team", () => {
  assert.throws(
    () => deriveSeason({ ...inputs, played: [{ week: 1, matchups: [game("A", 1, "B", 2)] }] }),
    /not every team has a matchup/,
  );
  assert.throws(
    () => deriveSeason({ ...inputs, played: [{ week: 1, matchups: [game("A", 1, "Z", 2), game("C", 1, "D", 2)] }] }),
    /"Z" is not a team/,
  );
});

/** A league where standings are already decisive: wins 10,9,…,1 pattern over 6 teams, 3 spots. */
function league(remaining: SeasonSnapshot["remaining"]): SeasonSnapshot {
  const wins = [9, 8, 7, 3, 2, 1];
  return {
    league: "Sim League",
    season: "2026",
    through_week: 10,
    generated_at: "",
    config: { regular_season_end: 11, playoff_teams: 3 },
    teams: wins.map((w, i) => ({
      team: `T${i}`,
      manager: null,
      wins: w,
      losses: 10 - w,
      ties: 0,
      points_for: 1000 - i * 10,
      scores: [100 - i, 90 + i, 95, 105 - i, 88, 97, 101, 93, 99, 96],
      all_play: { wins: 0, losses: 0, ties: 0 },
      expected_wins: 0,
      luck: 0,
    })),
    swap: [],
    remaining,
  };
}

test("simulate: playoff probabilities sum to the number of playoff spots", () => {
  const odds = simulate(league([{ week: 11, matchups: [[0, 5], [1, 4], [2, 3]] }]), {}, { runs: 2000 });
  const total = odds.reduce((s, o) => s + o.playoff, 0);
  assert.ok(Math.abs(total - 3) < 1e-9, `sum ${total}`);
});

test("simulate: a team that has clinched is 100%, an eliminated one is 0%", () => {
  // One game left: T0–T2 cannot be caught by T3 (3 wins) or below.
  const odds = simulate(league([{ week: 11, matchups: [[0, 5], [1, 4], [2, 3]] }]), {}, { runs: 2000 });
  assert.deepEqual(odds.slice(0, 3).map((o) => o.playoff), [1, 1, 1]);
  assert.deepEqual(odds.slice(3).map((o) => o.playoff), [0, 0, 0]);
});

test("simulate: same seed, same answer; no games left means the standings are the odds", () => {
  const s = league([{ week: 11, matchups: [[0, 1], [2, 3], [4, 5]] }]);
  assert.deepEqual(simulate(s, {}, { runs: 500, seed: 7 }), simulate(s, {}, { runs: 500, seed: 7 }));
  const done = simulate(league([]), {}, { runs: 10 });
  assert.deepEqual(done.map((o) => o.playoff), [1, 1, 1, 0, 0, 0]);
  assert.equal(done[0].avg_wins, 9);
});

test("simulate: forcing a winner decides that game in every run", () => {
  // Bubble: T2 (7 wins) vs T3 (7 wins) for the last of 3 spots, T3 far behind on points.
  const s = league([{ week: 11, matchups: [[2, 3], [0, 5], [1, 4]] }]);
  s.teams[3].wins = 7;
  s.teams[3].losses = 3;
  s.teams[3].points_for = 500;
  const t3wins = simulate(s, { [pickKey(11, 0)]: 3 }, { runs: 1000 });
  const t2wins = simulate(s, { [pickKey(11, 0)]: 2 }, { runs: 1000 });
  assert.equal(t3wins[3].playoff, 1);
  assert.equal(t3wins[2].playoff, 0);
  assert.equal(t2wins[2].playoff, 1);
  assert.equal(t2wins[3].avg_wins, 7);
});

// --- publishSite: never throws -------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "muff-site-"));
const originalCwd = process.cwd();
const originalProvider = process.env.FANTASY_PROVIDER;
let publish: typeof import("../src/site/publish.ts");

before(async () => {
  delete process.env.HISTORY_BUCKET; // local FileStore, rooted in the scratch dir
  process.env.FANTASY_PROVIDER = "fixture"; // no network: an empty fixture store just fails
  process.chdir(scratch);
  publish = await import("../src/site/publish.ts");
});

after(() => {
  process.chdir(originalCwd);
  if (originalProvider === undefined) delete process.env.FANTASY_PROVIDER;
  else process.env.FANTASY_PROVIDER = originalProvider;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("publishSite returns null instead of throwing when the snapshot cannot be built", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    assert.equal(await publish.publishSite(), null);
  } finally {
    console.error = originalError;
  }
  assert.match(errors.join("\n"), /League site snapshot failed \(site\/season\.json\)/);
  assert.ok(!fs.existsSync(path.join(scratch, "data", "site", "season.json")));
});
