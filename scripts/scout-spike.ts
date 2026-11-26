/**
 * MUFF-72 spike — does Yahoo's league players collection give us the
 * available-player pool with league-scored weekly points?
 *
 * Nothing else in the repo calls this resource, so the URL shape is checked
 * here before the provider function is built on it. Read-only.
 *
 *   node --env-file=.env --experimental-strip-types scripts/scout-spike.ts [POS] [WEEK] [--raw]
 */

import { yahooFetch } from "../src/yahoo/client.ts";
import { resolveLeague } from "../src/mcp/yahoo-data.ts";

const args = process.argv.slice(2);
const raw = args.includes("--raw");
const [posArg, weekArg] = args.filter((a) => !a.startsWith("--"));
const position = posArg ?? "RB";

const league = await resolveLeague();
const week = weekArg ? Number(weekArg) : league.current_week;

const path =
  `league/${league.league_key}/players;status=A;position=${position}` +
  `;sort=PTS;sort_type=week;sort_week=${week};count=25` +
  `/stats;type=week;week=${week}`;

console.error(`${league.league_name} (${league.season}) week ${week}, current week ${league.current_week}`);
console.error(`GET ${path}\n`);

const data = (await yahooFetch(path)) as any;

if (raw) {
  console.log(JSON.stringify(data, null, 2));
} else {
  const players = data?.fantasy_content?.league?.[1]?.players ?? {};
  const first = players["0"]?.player;
  console.log("First player, raw:\n" + JSON.stringify(first, null, 2).slice(0, 3000) + "\n");
  console.log(`count=${players.count}`);
  for (const key of Object.keys(players)) {
    if (key === "count") continue;
    const p = players[key].player;
    const meta = Object.assign({}, ...p[0].filter((f: unknown) => f && !Array.isArray(f)));
    const points = p.find((f: any) => f?.player_points)?.player_points?.total;
    console.log(
      [
        String(meta.name?.full).padEnd(26),
        String(meta.display_position).padEnd(6),
        String(meta.editorial_team_abbr).padEnd(4),
        String(meta.status ?? "").padEnd(4),
        `own=${JSON.stringify(meta.ownership ?? null)}`,
        `pts=${points}`,
      ].join(" "),
    );
  }
}
