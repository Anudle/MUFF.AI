/**
 * MUFF-71 — build the league site's season snapshot by hand.
 *
 *   npm run site:snapshot                                   → data/site/season.json
 *   HISTORY_BUCKET=muff-digest-history-<acct> npm run site:snapshot   → the deployed store
 *
 * The Tuesday digest run does this on its own (publishSite, non-fatal); this
 * script is for the first publish, for local preview data, and for seeing the
 * error that the non-fatal path only logs.
 */

import { deriveSeason } from "../src/site/derive.ts";
import { carriedDigest, SITE_KEY } from "../src/site/publish.ts";
import { gatherSeasonInputs } from "../src/site/season.ts";
import { simulate } from "../src/site/sim.ts";
import { store, storeLabel } from "../src/store.ts";

const snapshot = deriveSeason(await gatherSeasonInputs());
// Keep the recap the last delivering digest run put there; this script has none of its own.
const digest = await carriedDigest(snapshot.season);
if (digest) snapshot.digest = digest;
await store.write(SITE_KEY, snapshot);

const odds = simulate(snapshot);
const games = snapshot.remaining.reduce((n, wk) => n + wk.matchups.length, 0);
console.log(
  `${snapshot.league} ${snapshot.season}: ${snapshot.teams.length} teams through week ${snapshot.through_week}, ` +
    `${games} regular-season games left (weeks ${snapshot.remaining.map((w) => w.week).join(", ") || "none"})`,
);
console.log("  #  record   PF     all-play   luck   playoff  team");
snapshot.teams.forEach((t, i) => {
  const rec = `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`;
  const ap = `${t.all_play.wins}-${t.all_play.losses}${t.all_play.ties ? `-${t.all_play.ties}` : ""}`;
  console.log(
    `  ${String(i + 1).padStart(2)} ${rec.padEnd(8)} ${String(t.points_for).padEnd(6)} ${ap.padEnd(10)} ` +
      `${(t.luck >= 0 ? "+" : "") + t.luck.toFixed(2)}  ${(odds[i].playoff * 100).toFixed(0).padStart(4)}%    ${t.team}`,
  );
});
console.log(`Wrote ${storeLabel}${SITE_KEY}`);
