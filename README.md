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

Verify either path end-to-end over real MCP stdio:

```bash
FANTASY_PROVIDER=sleeper SLEEPER_LEAGUE_ID=<id> SLEEPER_USERNAME=<name> node --experimental-strip-types scripts/mcp-verify.ts
```

Details: `docs/mcp-tools.md` (tool contracts), `docs/sleeper-spike.md`
(endpoint mapping + gaps).
