/**
 * MUFF-72 — the free-agent scout's arithmetic and its two promises: a pickup
 * is pinged once per week, and nothing private leaks into the alert text
 * beyond the owner's own roster.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OPTIONS, deriveScout, newAlerts, weakest } from "../src/scout/derive.ts";
import { renderAlert, renderBoardHtml } from "../src/scout/render.ts";
import type { PoolPlayer, RosterPlayer, ScoutInputs } from "../src/scout/types.ts";

let n = 0;
const fa = (name: string, position: string, points: number | null, season: number | null = 0): PoolPlayer => ({
  player_key: `p.${++n}`,
  name,
  position,
  nfl_team: "TST",
  status: null,
  bye_week: null,
  points,
  season_points: season,
});
const mine = (
  name: string,
  position: string,
  slot: string,
  points: number | null,
  season: number | null,
): RosterPlayer => ({ ...fa(name, position, points, season), slot });

const base = (roster: RosterPlayer[], free_agents: PoolPlayer[]): ScoutInputs => ({
  league: "Test League",
  season: "2026",
  week: 11,
  live: false,
  team: "My Team",
  roster,
  free_agents,
});

const boardOf = (inputs: ScoutInputs, position: string) =>
  deriveScout(inputs).board.find((b) => b.position === position)!;

test("weakest: fewest season points, then bench before starter, then the worse week", () => {
  const star = mine("Star", "RB", "RB", 2, 120);
  const benchTie = mine("Bench", "RB", "BN", 9, 30);
  const starterTie = mine("Starter", "RB", "RB", 1, 30);
  assert.equal(weakest([star, starterTie, benchTie])?.name, "Bench");
  assert.equal(weakest([star])?.name, "Star");
  assert.equal(weakest([]), null);
});

test("gains are measured against the weakest player at the position", () => {
  const inputs = base(
    [mine("Star", "RB", "RB", 20, 150), mine("Scrub", "RB", "BN", 3, 20)],
    [fa("Breakout", "RB", 14, 32), fa("Meh", "RB", 6, 40)],
  );
  const rb = boardOf(inputs, "RB");
  assert.equal(rb.drop, "Scrub");
  assert.deepEqual(
    rb.candidates.map((c) => [c.name, c.week_gain, c.season_gain, c.alert]),
    [
      ["Breakout", 11, 12, true],
      ["Meh", 3, 20, false], // under the 10-point bar
    ],
  );
});

test("threshold edges: both the points bar and the gain bar must be met exactly", () => {
  const roster = [mine("Mine", "WR", "WR", 5, 50)];
  const at = deriveScout(base(roster, [fa("AtBar", "WR", 10)]));
  assert.equal(at.alerts.length, 1); // 10 pts, +5
  const shortGain = deriveScout(base([mine("Mine", "WR", "WR", 6, 50)], [fa("Short", "WR", 10)]));
  assert.equal(shortGain.alerts.length, 0); // 10 pts, +4
  const shortPoints = deriveScout(base([mine("Mine", "WR", "WR", 0, 50)], [fa("Low", "WR", 9)]));
  assert.equal(shortPoints.alerts.length, 0); // +9 but only 9 pts
});

test("K and DEF also need a season lead; skill positions do not", () => {
  const roster = [mine("My K", "K", "K", 5, 80), mine("My WR", "WR", "WR", 2, 80)];
  const scout = deriveScout(
    base(roster, [
      fa("Hot Leg", "K", 18, 60), // great week, worse season
      fa("Steady Leg", "K", 14, 95),
      fa("One Week", "WR", 15, 15),
    ]),
  );
  assert.deepEqual(scout.alerts.map((a) => a.name).sort(), ["One Week", "Steady Leg"]);
});

test("a dual-position free agent is pinged once, where he helps most", () => {
  const scout = deriveScout(
    base(
      [mine("My WR", "WR", "WR", 8, 60), mine("My RB", "RB", "RB", 1, 60)],
      [fa("Swiss", "WR,RB", 14, 14)],
    ),
  );
  assert.equal(scout.board.find((b) => b.position === "WR")!.candidates.length, 1);
  assert.equal(scout.board.find((b) => b.position === "RB")!.candidates.length, 1);
  assert.equal(scout.alerts.length, 1);
  assert.equal(scout.alerts[0].position, "RB"); // +13 there, +6 at WR
});

test("pings are capped per position; the board keeps everyone", () => {
  const pool = [16, 15, 14, 13, 12].map((p, i) => fa(`WR${i}`, "WR", p));
  const scout = deriveScout(base([mine("Mine", "WR", "BN", 0, 10)], pool));
  assert.equal(scout.board.find((b) => b.position === "WR")!.candidates.filter((c) => c.alert).length, 5);
  assert.deepEqual(scout.alerts.map((a) => a.name), ["WR0", "WR1", "WR2"]);
  assert.equal(DEFAULT_OPTIONS.maxAlertsPerPosition, 3);
});

test("no one rostered at the position: the free agent's points are the gain", () => {
  const scout = deriveScout(base([], [fa("Only TE", "TE", 9, 30)]));
  const [c] = scout.board.find((b) => b.position === "TE")!.candidates;
  assert.equal(c.drop, null);
  assert.equal(c.week_gain, 9);
  assert.equal(c.season_gain, null);
  assert.equal(c.alert, true);
});

test("a free agent with no points yet is left off; negative points are kept", () => {
  const scout = deriveScout(
    base([mine("My DEF", "DEF", "DEF", 6, 50)], [fa("Not Played", "DEF", null), fa("Bad Day", "DEF", -4, 46)]),
  );
  assert.deepEqual(
    scout.board.find((b) => b.position === "DEF")!.candidates.map((c) => [c.name, c.week_gain]),
    [["Bad Day", -10]],
  );
});

test("newAlerts drops what was already sent this week", () => {
  const scout = deriveScout(
    base([mine("Mine", "WR", "BN", 0, 10)], [fa("First", "WR", 15), fa("Second", "WR", 12)]),
  );
  const [first, second] = scout.alerts;
  assert.deepEqual(newAlerts(scout.alerts, []).map((a) => a.name), ["First", "Second"]);
  assert.deepEqual(newAlerts(scout.alerts, [first.player_key]).map((a) => a.name), ["Second"]);
  assert.deepEqual(newAlerts(scout.alerts, [first.player_key, second.player_key]), []);
});

test("renderAlert carries every number from the candidate and escapes Telegram markup", () => {
  const scout = deriveScout(
    base([mine("My_Guy", "RB", "BN", 3, 20)], [{ ...fa("A*Star", "RB", 14, 32), status: "Questionable" }]),
  );
  const text = renderAlert({ ...scout, live: true }, scout.alerts);
  assert.match(text, /week 11 \(in progress\): 1 free agent worth a look/);
  assert.match(text, /\*A\\\*Star\* \(RB, TST\): 14 pts, 32 season/);
  assert.match(text, /vs My\\_Guy: 3 pts, 20 season \(\+11 this week\)/);
  assert.match(text, /status: Questionable/);
  assert.match(text, /Points are partial/);
});

test("renderBoardHtml escapes names and marks the page private", () => {
  const scout = deriveScout(base([mine("Mine", "WR", "BN", 0, 10)], [fa("<b>Bobby</b>", "WR", 15)]));
  const page = renderBoardHtml(scout, "2026-11-25T00:00:00.000Z");
  assert.ok(page.includes("&lt;b&gt;Bobby&lt;/b&gt;"));
  assert.ok(!page.includes("<b>Bobby</b>"));
  assert.ok(page.includes('name="robots" content="noindex"'));
  assert.ok(page.includes('class="alert"'));
});
