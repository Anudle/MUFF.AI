# Sleeper API spike — endpoint→tool mapping (MUFF-49, step 1)

**Verdict: the swap works.** Every field our five MCP tools promise
(docs/mcp-tools.md) can be filled from Sleeper's zero-auth API except
`projected_points` (gap #1 below). Player-level granularity is *better* than
Yahoo's: one `matchups` call returns every team's full roster with per-player
weekly points, where Yahoo cost us one call per team.

Thin client: `npm run spike:sleeper -- <week>` (scripts/sleeper-spike.ts)
prints all five tool shapes from live data.

## Test league

`SLEEPER_LEAGUE_ID=1251080762300583936` — "Par-Laid Days", 2025, 12-team
superflex redraft, complete season, 17 scored weeks, real waiver activity.

Found by walking public data (that's the demo hook: *any* username → their
leagues → full league data, no OAuth). Two league-shape traps to check before
trusting a test league, both in `league.settings`:

- `best_ball: 1` — lineups auto-optimize, so bench/start-sit facts are
  meaningless (first candidate league had this)
- `league_average_match: 1` — an extra game vs league median each week, so
  wins ≠ weeks and matchup pairing breaks

## Endpoint mapping

Base `https://api.sleeper.app/v1` · read-only · no auth · ~90 req/min per IP.

| MCP tool | Sleeper call(s) | Notes |
|---|---|---|
| `get_week_results` | `league/{id}/matchups/{week}` | Entries pair by `matchup_id`; winner = higher `points` (no winner field; tie = equality). Playoff weeks include consolation games, `matchup_id` can be null for byes. |
| `get_roster` / league rosters | same `matchups/{week}` call | `players`/`starters` + `players_points` per team. Bench = players − starters. ONE call covers all 12 teams (Yahoo: 12 calls). |
| `get_standings` | `league/{id}/rosters` | No standings endpoint — derive: sort by `settings.wins` then points-for. **Season points split across two ints:** `fpts + fpts_decimal/100`. Streak free in `roster.metadata.streak` ("3L" → our "L3"). |
| `get_matchup` | `matchups/{week}` filtered to my roster | "My team": `SLEEPER_USERNAME` → `user/{name}` → match `owner_id` in rosters. |
| `get_transactions` | `league/{id}/transactions/{week}` | Per-week, not per-league (loop recent weeks for "last N"). `adds`/`drops` are `{player_id: roster_id}` maps. **Filter `status: "failed"` waivers** or the digest will roast moves that never happened. |
| league/team resolution | `league/{id}`, `league/{id}/users`, `state/nfl` | Team display name is `users[].metadata.team_name` (fallback `display_name`) — a roster belongs to a user, there's no team entity. `state/nfl` gives current season/week. |

## Player names — the 14.6MB problem

Everything above speaks player IDs. `players/nfl` maps ID → name, but the blob
is now **14.6MB / 12,225 players / 53 fields each** (docs still say 5MB).
Measured: trimmed to `id → {name, pos, team}` it's **760KB** — small enough
for Lambda memory, cached in S3, refreshed daily (step 3). Only the ~15 names
a tool answer references ever cross the tool boundary. The spike caches the
trimmed map at `.cache/sleeper-players.json` (24h TTL, gitignored).

## Gaps vs the Yahoo contract

| Gap | Disposition |
|---|---|
| **No projected points** in the documented API → `overachiever`/`underachiever` digest facts | v1: return `projected_points: null`. facts.ts already filters null projections; those two facts become null and the digest skips them. Follow-up: undocumented `api.sleeper.com/projections/nfl/{season}/{week}` works (verified live, per-player `pts_ppr/half/std`) but is unstable + generic scoring — sum of starters' projections would be approximate. Decide in step 2 review. |
| No per-player injury `status_full` / `bye_week` in league calls | Both live in the players blob (`injury_status`, plus bye via schedule). Trim map can carry them if the agent path needs them; digest doesn't. |
| No `WEEK_NOT_AVAILABLE` signal — out-of-range weeks return `[]` not an error | Adapter enforces range itself from `league.settings.leg` / `state/nfl`, same error envelope as today. |
| `AUTH_EXPIRED` error class is meaningless (no auth) | Adapter never emits it; envelope/codes otherwise unchanged — tool descriptions survive the swap untouched. |
| Bonus, not a gap: `settings.ppts` = max-possible points (optimal lineup) | Free "manager efficiency" fact Yahoo never gave us. Candidate new digest fact. |

## Adapter seam (step 2 preview)

The provider boundary is the six shaped fetchers in `src/mcp/yahoo-data.ts`
(`getRoster`, `getMatchup`, `getStandings`, `getTransactions`,
`getWeekResults`, `getLeagueRosters`) plus `resolveLeague()`. Sleeper
implements the same signatures; `FANTASY_PROVIDER=sleeper|yahoo` picks the
module at startup. Nothing in build-server.ts, facts.ts, or the eval suite
changes — that's the acceptance test.

## CCA-F debrief hooks

- **Domain 2 (Tool Design):** the five tool descriptions mention zero Yahoo
  concepts, so they survive the backend swap verbatim — this is why provider
  ugliness was kept server-side in MUFF-15.
- **Domain 5 (Context Mgmt):** 14.6MB players blob → 760KB server-side map →
  ~15 names in a tool answer. Three tiers of trimming, none visible to the
  agent.
