/**
 * MUFF-16 — the eval suite. `npm run eval` and the GitHub Actions gate.
 *
 * Three things, in order:
 *
 *   1. Checker self-test (always): every fixture in eval/fixtures/ gets a
 *      synthetic grounded digest (must pass) and a corrupted one (must fail
 *      groundedness). Free, deterministic, no keys — this is the PR gate.
 *   2. Score archived run records (always): everything in data/runs/ and
 *      eval/golden/, plus any paths given as arguments. This is where the
 *      real season gets graded once runs exist.
 *   3. `--live` (optional, costs money): run the ACTUAL digest pipeline —
 *      generateDigest on claude-opus-4-8 — against each fixture and score
 *      the real model output. The golden-dataset eval proper: frozen inputs,
 *      live model, rule-checked outputs. Needs ANTHROPIC_API_KEY.
 *
 *   npm run eval                     # self-test + score archived records
 *   npm run eval -- data/runs/x.json # also score a specific record
 *   npm run eval -- --live           # + generate from fixtures and score
 *
 * Exit code is the contract: non-zero on any failure, so CI needs no parsing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RunRecord } from "../src/digest/archive.ts";
import type { WeekFacts } from "../src/digest/facts.ts";
import { renderDigest } from "../src/digest/render.ts";
import { collectFactNumbers, evaluateRecord, type EvalReport } from "../src/eval/checks.ts";
import { buildGroundedDigest, corruptDigest } from "../src/eval/synthetic.ts";

const FIXTURES_DIR = path.join(process.cwd(), "eval", "fixtures");
const RECORD_DIRS = [path.join(process.cwd(), "data", "runs"), path.join(process.cwd(), "eval", "golden")];

const args = process.argv.slice(2);
const live = args.includes("--live");
const explicit = args.filter((a) => !a.startsWith("--"));

let failures = 0;

function report(label: string, r: EvalReport, expectFail?: string) {
  if (expectFail) {
    // A corrupted digest must fail the named check — and only make it visible.
    const target = r.checks.find((c) => c.id === expectFail);
    const ok = target !== undefined && !target.ok;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) {
      failures++;
      console.log(`        expected check "${expectFail}" to flag the planted hallucination and it did not`);
    }
    return;
  }
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${label}`);
  for (const c of r.checks.filter((c) => !c.ok)) {
    console.log(`        ${c.id}: ${c.detail}`);
  }
  if (!r.pass) failures++;
}

function jsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

const fixtureFiles = jsonFiles(FIXTURES_DIR);
if (fixtureFiles.length === 0) {
  console.error(`No fixtures in ${FIXTURES_DIR} — nothing to gate on.`);
  process.exit(1);
}

// --- 1. checker self-test -----------------------------------------------------
console.log(`Checker self-test — ${fixtureFiles.length} fixture(s)`);
for (const file of fixtureFiles) {
  const facts = JSON.parse(fs.readFileSync(file, "utf8")) as WeekFacts;
  const name = path.basename(file, ".json");

  const grounded = buildGroundedDigest(facts);
  report(`${name} (grounded digest passes)`, evaluateRecord({ facts, digest: grounded, text: renderDigest(facts, grounded) }));

  const corrupted = corruptDigest(grounded, collectFactNumbers(facts));
  report(
    `${name} (planted hallucination caught)`,
    evaluateRecord({ facts, digest: corrupted, text: renderDigest(facts, corrupted) }),
    "groundedness",
  );
}

// --- 2. archived run records --------------------------------------------------
const recordFiles = [...RECORD_DIRS.flatMap(jsonFiles), ...explicit];
console.log(`\nRun records — ${recordFiles.length} found`);
for (const file of recordFiles) {
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
  report(
    `${path.relative(process.cwd(), file)} (${run.season} w${run.week})`,
    evaluateRecord({ facts: run.facts, digest: run.digest, text: run.text }),
  );
}
if (recordFiles.length === 0) {
  console.log("  (none yet — records land in data/runs/ via `npm run runs -- --pull`)");
}

// --- 3. live golden-dataset eval ----------------------------------------------
if (live) {
  const { generateDigest } = await import("../src/digest/generate.ts");
  const { formatCost } = await import("../src/digest/cost.ts");
  console.log(`\nLive eval — generating against ${fixtureFiles.length} fixture(s)`);
  for (const file of fixtureFiles) {
    const facts = JSON.parse(fs.readFileSync(file, "utf8")) as WeekFacts;
    const { digest, cost } = await generateDigest(facts);
    report(`${path.basename(file, ".json")} — ${formatCost(cost)}`, {
      ...evaluateRecord({ facts, digest, text: renderDigest(facts, digest) }),
    });
  }
}

console.log(failures === 0 ? "\nAll checks green." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
