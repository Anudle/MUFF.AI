/**
 * MUFF-16 — what the archive holds: one row per digest run, cost totalled.
 *
 *   npm run runs                     → table of archived runs + season totals
 *   npm run runs -- --pull           → also copy each record into data/runs/
 *
 * Reads whatever store.ts is pointed at: with HISTORY_BUCKET set it reads the
 * deployed archive in S3, without it the local data/ directory. To inspect
 * production from a laptop:
 *
 *   HISTORY_BUCKET=muff-digest-history-<account-id> npm run runs
 *
 * `--pull` is how the golden set gets into the repo — the eval harness (the
 * rest of MUFF-16) scores records on disk, not over the network.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listRuns, loadRun, type RunRecord } from "../src/digest/archive.ts";
import { storeLabel } from "../src/store.ts";

const pull = process.argv.includes("--pull");

const keys = await listRuns();
if (keys.length === 0) {
  console.log(`No archived runs under ${storeLabel}runs/.`);
  console.log("(Set HISTORY_BUCKET to read the deployed archive.)");
  process.exit(0);
}

console.log(`${keys.length} run(s) in ${storeLabel}runs/\n`);

const header = ["DATE", "WK", "MODEL", "IN", "OUT", "COST", "SECS", "SENT"];
const rows: string[][] = [];
let total = 0;
let unpriced = 0;

for (const key of keys) {
  const run = await loadRun(key);
  if (!run) {
    console.error(`  (unreadable: ${key})`);
    continue;
  }
  if (run.cost.cost_usd === null) unpriced++;
  else total += run.cost.cost_usd;

  rows.push([
    run.finished_at.slice(0, 10),
    `${run.season} w${run.week}`,
    run.cost.model.replace(/^claude-/, ""),
    String(run.cost.input_tokens),
    String(run.cost.output_tokens),
    run.cost.cost_usd === null ? "?" : `$${run.cost.cost_usd.toFixed(4)}`,
    (run.duration_ms / 1000).toFixed(1),
    run.delivery_attempted ? "yes" : "dry",
  ]);

  if (pull) writeLocal(key, run);
}

printTable(header, rows);

const priced = rows.length - unpriced;
console.log(`\nTotal: $${total.toFixed(4)} over ${priced} priced run(s)`);
if (priced > 0) {
  const avg = total / priced;
  console.log(`Mean:  $${avg.toFixed(4)}/run`);
  // An NFL fantasy season is 17 recap Tuesdays (weeks 1-17, championship
  // included) — the number that answers "will the balance survive the season".
  console.log(`Projected 17-week season: $${(avg * 17).toFixed(2)}`);
}
if (unpriced > 0) console.log(`${unpriced} run(s) on a model with no rate in cost.ts.`);
if (pull) console.log(`\nPulled ${rows.length} record(s) into data/runs/.`);

function writeLocal(key: string, run: RunRecord) {
  const file = path.join(process.cwd(), "data", key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(run, null, 1) + "\n");
}

function printTable(head: string[], body: string[][]) {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of body) console.log(line(r));
}
