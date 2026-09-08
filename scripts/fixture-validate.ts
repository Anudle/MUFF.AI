/**
 * MUFF-57 — validate a hand-transcribed weekly fixture before it goes anywhere.
 *
 *   npm run fixture:validate fixtures/weekly/2026-w01.json
 *   npm run fixture:validate fixtures/weekly/2026-w02.json -- --prev fixtures/weekly/2026-w01.json
 *   npm run fixture:validate <fixture> -- --facts out.json   # also write the derived WeekFacts
 *
 * Three passes, each only if the previous one was clean:
 *   1. schema  — the zod contract (src/ingest/weekly-fixture.ts): every required
 *                field present and typed; `_`-prefixed hint keys are ignored.
 *   2. checks  — cross-field consistency (records vs results, streaks, season
 *                totals, and every delta against last week's fixture with --prev).
 *   3. derive  — run the real deriveWeekFacts() and print what the digest would
 *                be told, so the transcriber eyeballs the superlatives once.
 *
 * Exit code is the contract (same rule as scripts/eval.ts): non-zero on any
 * error, so the MUFF-58 upload step can refuse a bad fixture without parsing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkWeeklyFixture,
  fixtureToFacts,
  parseWeeklyFixture,
  type FixtureIssue,
  type WeeklyFixture,
} from "../src/ingest/weekly-fixture.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--prev" && args[i - 1] !== "--facts");
const file = positional[0];
if (!file) {
  console.error("usage: npm run fixture:validate <fixture.json> [-- --prev <last-week.json>] [--facts <out.json>]");
  process.exit(2);
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Cannot read ${p}: ${(e as Error).message}`);
    process.exit(2);
  }
}

function print(issues: FixtureIssue[]) {
  for (const i of issues) console.log(`  ${i.level === "error" ? "ERROR" : "warn "}  ${i.path}: ${i.message}`);
}

function loadPrev(p: string): WeeklyFixture {
  const parsed = parseWeeklyFixture(readJson(p));
  if (!parsed.fixture) {
    console.log(`--prev ${p} does not itself validate:`);
    print(parsed.issues);
    process.exit(1);
  }
  return parsed.fixture;
}

const relative = path.relative(process.cwd(), file);
const rel = relative.startsWith("..") ? file : relative;
console.log(`Fixture: ${rel}`);

// --- 1. schema ----------------------------------------------------------------
const parsed = parseWeeklyFixture(readJson(file));
if (!parsed.fixture) {
  console.log(`Schema: ${parsed.issues.length} problem(s)`);
  print(parsed.issues);
  console.log("\nFix the fields above (see fixtures/weekly/TEMPLATE.json for the _source of each).");
  process.exit(1);
}
const fixture = parsed.fixture;
console.log(`Schema: OK — ${fixture.league} ${fixture.season} week ${fixture.week}, ${fixture.matchups.length} matchups, ${fixture.standings.length} teams`);

// --- 2. cross-field checks ----------------------------------------------------
const prevPath = flag("--prev");
const prev = prevPath ? loadPrev(prevPath) : null;
const issues = checkWeeklyFixture(fixture, prev);
const errors = issues.filter((i) => i.level === "error").length;
const warnings = issues.length - errors;
console.log(`Checks: ${errors} error(s), ${warnings} warning(s)${prev ? ` (cross-checked against week ${prev.week})` : " (no --prev: record/points_for deltas not verified)"}`);
print(issues);
if (errors > 0) process.exit(1);

// --- 3. derive ----------------------------------------------------------------
const facts = fixtureToFacts(fixture);
const fmt = (n: number | null) => (n === null ? "?" : n.toFixed(2));
console.log("\nDerived facts the digest would receive:");
for (const g of facts.results) {
  const [a, b] = g.teams;
  console.log(`  ${a.team} ${fmt(a.points)} – ${fmt(b.points)} ${b.team}${g.is_tied ? "  (tie)" : ` → ${g.winner}`}`);
}
if (facts.highest_scorer) console.log(`  high: ${facts.highest_scorer.team} ${facts.highest_scorer.points}`);
if (facts.lowest_scorer) console.log(`  low:  ${facts.lowest_scorer.team} ${facts.lowest_scorer.points}`);
if (facts.closest_game) console.log(`  closest: ${facts.closest_game.teams.join(" vs ")} by ${facts.closest_game.margin}`);
if (facts.biggest_blowout) console.log(`  blowout: ${facts.biggest_blowout.winner} over ${facts.biggest_blowout.loser} by ${facts.biggest_blowout.margin}`);
if (facts.overachiever) console.log(`  over/under projection: ${facts.overachiever.team} +${facts.overachiever.delta} / ${facts.underachiever?.team} ${facts.underachiever?.delta}`);
if (facts.bench_points.length) console.log(`  bench: ${facts.bench_points.map((b) => `${b.team} ${b.bench_points}`).join(", ")}`);
console.log(
  facts.worst_start_sit
    ? `  worst start/sit: ${facts.worst_start_sit.team} benched ${facts.worst_start_sit.benched.name} (${facts.worst_start_sit.benched.points}) over ${facts.worst_start_sit.started.name} (${facts.worst_start_sit.started.points}) — Δ${facts.worst_start_sit.delta}${facts.worst_start_sit.would_have_flipped_result ? ", would have flipped the result" : ""}`
    : "  worst start/sit: none (no start_sit entries)",
);
console.log(`  standings: ${facts.standings.slice(0, 3).map((s) => `${s.rank}. ${s.team} ${s.record}`).join(" | ")} …`);
console.log(`  transactions: ${facts.recent_transactions.length}`);

const out = flag("--facts");
if (out) {
  fs.writeFileSync(out, JSON.stringify(facts, null, 1) + "\n");
  console.log(`\nWrote WeekFacts → ${out}`);
}
console.log("\nValid.");
