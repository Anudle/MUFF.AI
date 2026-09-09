/**
 * MUFF-58 — put a validated weekly fixture where the digest reads it.
 *
 *   npm run fixture:upload fixtures/weekly/2026-w03.json
 *   npm run fixture:upload fixtures/weekly/2026-w03.json -- --week 3      # refuse unless the file says week 3
 *   npm run fixture:upload fixtures/weekly/2026-w03.json -- --force       # overwrite an existing week
 *   HISTORY_BUCKET=muff-digest-history-<acct> npm run fixture:upload …    # the deployed bucket (else data/)
 *
 * Destination is the blob store (src/store.ts) — data/ locally, S3 with
 * HISTORY_BUCKET — at `fixtures/weekly/<season>-wNN.json`, the key
 * FANTASY_PROVIDER=fixture derives for (season, week). No "latest" pointer
 * is written: the newest key in the listing is the latest week.
 *
 * The gate is the MUFF-57 validator, run in-process: schema, then the
 * cross-field checks — against last week's fixture pulled from the SAME
 * store when it exists, so the exact record/points_for deltas are checked
 * automatically on every upload after the first. Any error refuses the
 * upload before anything touches S3.
 *
 * Provenance: `source.ingested_at` is stamped here (UTC, now) in both the
 * uploaded object and the local file, so the repo copy and the store copy
 * stay byte-equivalent in content. `ingested_by` is required by the schema
 * and typed by the human.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkWeeklyFixture,
  fixtureKey,
  parseWeeklyFixture,
  type FixtureIssue,
  type WeeklyFixture,
} from "../src/ingest/weekly-fixture.ts";
import { store, storeLabel } from "../src/store.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--week");
const file = positional[0];
const force = args.includes("--force");
const expectWeek = flag("--week") !== undefined ? Number(flag("--week")) : undefined;

if (!file || (expectWeek !== undefined && !Number.isInteger(expectWeek))) {
  console.error("usage: npm run fixture:upload <fixture.json> [-- --week N] [--force]");
  process.exit(2);
}

function fail(msg: string): never {
  console.error(`\nREFUSED: ${msg}`);
  process.exit(1);
}

function print(issues: FixtureIssue[]) {
  for (const i of issues) console.log(`  ${i.level === "error" ? "ERROR" : "warn "}  ${i.path}: ${i.message}`);
}

let raw: unknown;
try {
  raw = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  fail(`cannot read ${file}: ${(e as Error).message}`);
}
console.log(`Fixture: ${path.relative(process.cwd(), file) || file}`);

// --- 1. schema ----------------------------------------------------------------
const parsed = parseWeeklyFixture(raw);
if (!parsed.fixture) {
  console.log(`Schema: ${parsed.issues.length} problem(s)`);
  print(parsed.issues);
  fail("fixture does not match the contract — run `npm run fixture:validate` and fix the fields above.");
}
const fixture: WeeklyFixture = parsed.fixture;
console.log(`Schema: OK — ${fixture.league} ${fixture.season} week ${fixture.week}, ${fixture.matchups.length} matchups, ${fixture.standings.length} teams`);

if (expectWeek !== undefined && expectWeek !== fixture.week) {
  fail(`--week ${expectWeek} but the file says week ${fixture.week}. One of them is wrong; fix it before uploading.`);
}

// --- 2. cross-field checks, against last week from the store ----------------
const prevKey = fixtureKey(fixture.season, fixture.week - 1);
const prevRaw = fixture.week > 1 ? await store.read<unknown>(prevKey) : null;
let prev: WeeklyFixture | null = null;
if (prevRaw !== null) {
  const p = parseWeeklyFixture(prevRaw);
  if (!p.fixture) fail(`last week's fixture ${storeLabel}${prevKey} no longer validates; re-upload it first.`);
  prev = p.fixture;
}
const issues = checkWeeklyFixture(fixture, prev);
const errors = issues.filter((i) => i.level === "error").length;
console.log(
  `Checks: ${errors} error(s), ${issues.length - errors} warning(s)` +
    (prev
      ? ` (cross-checked against ${storeLabel}${prevKey})`
      : fixture.week > 1
        ? ` (no week ${fixture.week - 1} in ${storeLabel}: deltas not verified — upload last week first for exact checks)`
        : ""),
);
print(issues);
if (errors > 0) fail("fix the errors above; nothing was uploaded.");

// --- 3. stamp provenance + refuse silent overwrite ----------------------------
const key = fixtureKey(fixture.season, fixture.week);
if (!force && (await store.read<unknown>(key)) !== null) {
  fail(`${storeLabel}${key} already exists. Re-run with --force to replace it (the digest re-reads on its next run).`);
}

const ingestedAt = new Date().toISOString();
fixture.source.ingested_at = ingestedAt;

// Upload the canonical form: hints stripped, defaults applied, stamped.
await store.write(key, fixture);

// Mirror the stamp into the local file, hints and all, so what is committed
// matches what was uploaded.
const local = raw as { source?: Record<string, unknown> };
if (local.source) {
  local.source.ingested_at = ingestedAt;
  fs.writeFileSync(file, JSON.stringify(local, null, 2) + "\n");
}

console.log(`\nUploaded → ${storeLabel}${key}`);
console.log(`Provenance: source=${fixture.source.kind} ingested_by=${fixture.source.ingested_by} ingested_at=${ingestedAt}`);
console.log(
  process.env.HISTORY_BUCKET
    ? `\nNext: FANTASY_PROVIDER=fixture on the digest Lambda reads it. Dry run:\n  aws lambda invoke --function-name muff-digest --region us-east-2 --cli-read-timeout 320 \\\n    --payload '{"week": ${fixture.week}, "dry_run": true}' --cli-binary-format raw-in-base64-out /tmp/digest-out.json`
    : `\nNext: FANTASY_PROVIDER=fixture npm run digest -- --week ${fixture.week}   (reads ${storeLabel}${key})`,
);
