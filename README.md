# MUFF.ai 🏈

Monarch United Fantasy Football's agentic league companion. Claude agent over fantasy league data (MCP tools), delivered via Telegram bot + an autonomous Tuesday digest forwarded to the league's WhatsApp group.

## Data providers

The five MCP tools and the digest are provider-blind: they import from
`src/mcp/data.ts`, which picks a backend at startup. The swap is config-only
(MUFF-49) — no code changes, tool schemas identical either way.

| | Yahoo (default) | Sleeper |
|---|---|---|
| Select with | `FANTASY_PROVIDER=yahoo` (or unset) | `FANTASY_PROVIDER=sleeper` |
| Auth | OAuth app + `npm run auth` | none (public read-only API) |
| League | auto-discovered (`YAHOO_LEAGUE_KEY` overrides) | `SLEEPER_LEAGUE_ID` (required) |
| "My team" | from login | `SLEEPER_USERNAME` (optional — league-wide tools work without it) |
| Projected points | yes | no → over/underachiever digest facts are omitted |
| Player names | inline in API responses | trimmed `/players/nfl` map, synced daily to S3 (`npm run deploy:sync`), local runs cache under `data/players/` |

Verify either path end-to-end over real MCP stdio:

```bash
FANTASY_PROVIDER=sleeper SLEEPER_LEAGUE_ID=<id> SLEEPER_USERNAME=<name> node --experimental-strip-types scripts/mcp-verify.ts
```

Details: `docs/mcp-tools.md` (tool contracts), `docs/sleeper-spike.md`
(endpoint mapping + gaps).

## Degraded mode — manual ingestion

Yahoo's Fantasy API sat behind a developer-access review until mid-September
2026, and it will 999 on some Tuesday eventually. Rather than scrape (against
Yahoo's ToS) or skip the week, the pipeline has a third provider:
`FANTASY_PROVIDER=fixture`. A human reads the league's Yahoo screens and types
the week's raw numbers — standings, matchup scores, bench totals, the worst
start/sit — into `fixtures/weekly/<season>-wNN.json`, following
`docs/ingestion-checklist.md` field by field.

The boundary is deliberate: the human transcribes **raw inputs**, never
conclusions. `npm run fixture:validate` cross-checks the file (records add up,
season points grow by exactly this week's score, streaks match results) and
`deriveWeekFacts()` — the same code the Yahoo path uses — computes every margin,
superlative and delta. From there nothing changes: the same Opus call, the same
rule gate, the same render. Every `WeekFacts` carries `provenance`
(`source: manual`, who, when); it is archived and logged (`MUFF_RUN` →
`source: "manual"`) but stripped before the model sees the facts, so the league
can't tell a transcribed week from an API week and the model can't cite a
timestamp.

Entering: `npm run fixture:upload <path>` (validates again, refuses on any
error, writes to the store) then `FANTASY_PROVIDER=fixture npm run deploy:digest`.
Exiting when Yahoo is back: `npm run smoke`, then `FANTASY_PROVIDER=yahoo npm run deploy:digest`.
The fixture path stays deployed-ready as the documented fallback; the week-by-week
procedure, including the go/no-go check before the 7:00 MT Tuesday run, is
`docs/tuesday-runbook.md`.
