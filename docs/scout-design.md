# Free-agent scout (MUFF-72)

A private tool for the owner: rank the league's available players against my
own roster and DM me the pickups worth acting on. The league has no waivers
(`league-rules.md`: free agents are first come, first served), so noticing a
breakout first is the whole edge.

```
npm run scout                 # current week, print the board, send nothing
npm run scout -- --week 11    # what today's free agents scored in week 11
npm run scout -- --send       # DM new pickups to TELEGRAM_ADMIN_CHAT_ID
npm run scout -- --min-gain 3 # lower the gain bar (default 5)
npm run scout -- --open       # open data/scout/board.html
```

## Shape

Same split as the digest (`digest-design.md`): fetch, pure derive, render in
code.

```
getFreeAgents(week)        src/mcp/data.ts → yahoo-data.ts   fetch
deriveScout(inputs, opts)  src/scout/derive.ts               pure arithmetic
renderAlert / renderBoard  src/scout/render.ts               layout
runScout                   src/scout/run.ts                  dedupe, write, send
```

- **Fetch.** One Yahoo call per position
  (`league/{lk}/players;status=A;position=P;sort=PTS;sort_type=week;sort_week=W;count=25/stats;type=week;week=W`),
  my roster for the same week, then season totals for everyone by player key
  (25 keys per call). About ten calls, one at a time: `yahooFetch` has no
  backoff and nothing here is latency-sensitive.
- **Derive.** Per position, "my weakest player" is the one with the fewest
  season points (bench before starter on a tie). Every free agent gets a
  `week_gain` and a `season_gain` against him.
- **Alert rule.** A ping needs the free agent's week to clear a per-position
  points bar (QB 18, WR/RB 10, TE 8, K/DEF 12) *and* beat my weakest player by
  `minGain` (5). K and DEF also need a season lead, because one big week at
  those positions is mostly noise. At most three pings per position per run;
  the board shows the rest.
- **Dedupe.** `scout/<season>-wNN.json` in the store remembers the player
  keys already sent, so running it at halftime and again at the final does not
  repeat itself. A pickup is only remembered once Telegram accepted the
  message; a print-only run remembers nothing.

## Decisions

**Not an MCP tool.** `getFreeAgents` is exported from the provider seam like
`getSchedule`, and deliberately not registered in `build-server.ts`. The MCP
server is the league-facing agent's whole tool surface; the scout compares the
pool with *my* roster and is the owner's edge, not league information.

**Yahoo only.** The contract is `typeof yahoo`, so Sleeper and fixture export
the function and refuse with a "do not retry" error. Fixtures hold no player
pool; Sleeper has no weekly points for unrostered players in anything this
repo reads.

**No model call.** Ranking is arithmetic, so a model would add cost and a
grounding problem and no information. The planned Monday/Tuesday brief (the
"why": injuries ahead of him, role changes) is where a model with web search
earns its place, and it needs its own grounding rule first: league numbers
from these facts, news claims with links.

**Private by construction.** The scout writes to three places only: the store
key `scout/…`, the local file `data/scout/board.html`, and
`TELEGRAM_ADMIN_CHAT_ID`. It never writes under `site/` (anyone with the
league-site link reads that) and refuses to send if the admin chat id is
unset rather than falling back to the league chat. The board is a generated
file outside `web/`, so `npm run site:bundle` cannot pick it up.

**Calls `sendMessage` directly, not `notifyAdmin`.** `notifyAdmin`
(`src/whatsapp/alert.ts`) swallows failures, which is right for a sender
daemon's alerts and wrong here: a swallowed failure would mark a pickup as
sent that never arrived.

## What the spike found (2026-11-25)

- `status=A` returns the available pool, and `player_points.total` is
  league-scored: whole points, negatives included (a DEF at −4).
- `sort=PTS;sort_type=week;sort_week=W` sorts server-side, so the top 25 per
  position is one call with no paging.
- Dual-position players (`"WR,RB"`) come back under each position; the
  provider keeps one row and the derive lists him on both boards.
- Availability is always *as of now*. Asking for a past week answers "what did
  today's free agents score then", not "who was available then".

## Known limits

- **Mid-game freshness is unverified.** How quickly Yahoo's API reflects live
  points has not been measured; check it against the app during a live game
  before trusting a halftime run.
- **Live gains can overstate.** During a live week, my player who has not
  played yet shows 0, so the week gain is inflated. The alert text says so.
- **Adding a player whose game has started** may be restricted by Yahoo's
  lineup lock; unverified. The token is read-only (`fspt-r`), so the scout
  alerts and I make the move.
- **"Weakest" is season points only.** It ignores injuries, byes and matchup,
  and compares totals rather than per-game averages.

## Not built yet

- Scheduled Lambda (`src/scout/lambda.ts` + EventBridge Scheduler, one
  schedule per time slot). The deploy script is IaC and is Anu's; the pattern
  is `infra/deploy-players-sync.sh`, plus `TELEGRAM_ADMIN_CHAT_ID`, the Yahoo
  secret and an S3 `scout/*` grant.
- The web-research brief, multi-week trend, percent owned, other teams' needs.
