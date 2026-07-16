/**
 * Smoke test (ANU-11 acceptance criterion):
 * fetch the authenticated user's NFL leagues and print a readable summary.
 */

import { getNflLeagues } from "../src/yahoo/client.ts";

const data = (await getNflLeagues()) as Record<string, unknown>;

// Yahoo's JSON is index-keyed and deeply nested; walk it defensively.
function findLeagues(node: unknown, out: { name?: string; league_key?: string; season?: string }[] = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => findLeagues(n, out));
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.league_key === "string" && typeof obj.name === "string") {
      out.push({ name: obj.name as string, league_key: obj.league_key as string, season: obj.season as string });
    }
    Object.values(obj).forEach((v) => findLeagues(v, out));
  }
  return out;
}

const leagues = findLeagues(data);

if (leagues.length === 0) {
  console.log("Connected to Yahoo ✅ but found no NFL leagues (raw response below):\n");
  console.log(JSON.stringify(data, null, 2).slice(0, 2000));
} else {
  console.log(`\n✅ Yahoo connection works. Found ${leagues.length} league(s):\n`);
  for (const l of leagues) {
    console.log(`  • ${l.name}  (${l.season ?? "?"})  key=${l.league_key}`);
  }
  console.log("\nANU-11 acceptance criteria: met. 🎉\n");
}
