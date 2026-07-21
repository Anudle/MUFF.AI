# MUFF.ai MCP server — tool schemas (MUFF-15)

Server: `muff-yahoo-fantasy` v0.1.0 · stdio transport · `npm run mcp`
Five read-only tools wrapping the Yahoo Fantasy Sports API on top of the
MUFF-11 auth layer (auto-refreshing OAuth tokens in `.tokens.json`).

## Design decisions

**Granularity.** Five narrow tools, one job each, instead of a mega
`get_league_data(type, …)`. The model routes better when "when to use this
vs. that" lives in each description (`get_matchup` = my game,
`get_week_results` = everyone's games, `get_standings` = season-cumulative).

**Provider ugliness stays server-side.** Yahoo addresses everything by
`nnn.l.nnnnn.t.n` keys, splits entities across arrays of partial objects, and
index-keys its collections (`{"0": …, count: n}`). None of that crosses the
tool boundary: league and "my team" resolve automatically (newest season wins;
`YAHOO_LEAGUE_KEY` env var overrides), `week` defaults to the current week,
and responses are flat, named, trimmed JSON.

**Context budget.** Yahoo returns ~40 fields per player (headshot URLs,
editorial keys, …). Tools return the handful an agent needs — a full roster
answer is ~7 fields × 15 players. The digest's quality depends on clean,
token-efficient input, not raw payloads.

**Errors are data.** Handlers never raise. Every response is one envelope:

```jsonc
{ "status": "ok",    "data": { … } }
{ "status": "error", "code": "…", "message": "…" }
```

Messages tell the agent what to *do*, not just what broke:

| Code | Meaning | Agent guidance in message |
|---|---|---|
| `AUTH_EXPIRED` | Refresh failed or no tokens | Don't retry; tell user to run `npm run auth` |
| `RATE_LIMITED` | Yahoo 429/999 | Retry after ~60s |
| `WEEK_NOT_AVAILABLE` | Week outside played range | Don't retry that week; omit `week` for current |
| `LEAGUE_NOT_FOUND` | Bad league/team/resource | Don't retry same args |
| `UPSTREAM_ERROR` | Anything else (5xx, network) | Retry once, then report |

## Tools

### `get_roster`
The user's own roster for one week.

- **Input:** `week?: int (1–18)` — omit for current week
- **Returns:** `{league, season, week, team, players: [{name, position, slot, nfl_team, status, bye_week, points}]}` — `slot` of `BN` = benched
- **Constraints:** user's team only; read-only

### `get_matchup`
The user's head-to-head matchup for one week.

- **Input:** `week?: int (1–18)`
- **Returns:** `{league, season, week, my_team, status, is_tied, winner, teams: [{team, manager, points, projected_points}]}`
- **Constraints:** user's game only — use `get_week_results` for the whole league; read-only

### `get_standings`
Season-cumulative league standings.

- **Input:** none (no week — season-level data)
- **Returns:** `{league, season, standings: [{rank, team, manager, is_my_team, wins, losses, ties, points_for, points_against, streak}]}` — `streak` like `"W4"`/`"L2"`
- **Constraints:** read-only

### `get_transactions`
Recent league roster moves, newest first.

- **Input:** `count?: int (1–50)`, default 10
- **Returns:** `{league, season, transactions: [{type, status, date, players: [{name, position, action, from, to}]}]}` — `action` is `add`/`drop`/`trade`
- **Constraints:** all teams, not just the user's; read-only

### `get_week_results`
Every matchup in the league for one week (the digest's primary source).

- **Input:** `week?: int (1–18)`
- **Returns:** `{league, season, week, matchups: [{status, is_tied, winner, teams: [{team, manager, points, projected_points}]}]}`
- **Constraints:** read-only

## Verification

`node --experimental-strip-types scripts/mcp-verify.ts` drives the server over
stdio with the SDK's MCP client: lists tools, calls all five against the 2025
Monarch United league, and asserts the `WEEK_NOT_AVAILABLE` error path.
Interactive alternative: `npx @modelcontextprotocol/inspector npm run mcp`.

## v2 (deliberately out of scope)

- HTTP transport for the Lambda deployment (second session — don't let
  deployment eat the tool-design session)
- Side-effectful tools (set lineup, add/drop) — excluded until
  human-in-the-loop approval gates exist
