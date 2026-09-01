# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MUFF.ai — an agentic fantasy-football league companion. A Claude agent answers league questions over MCP tools (via Telegram), and an autonomous Tuesday digest recaps the week for the league's WhatsApp group. The repo doubles as a CCA-F study project: design docs in `docs/` record *why* each decision was made, and changes should keep those docs truthful.

## Commands

There is no build step: TypeScript runs directly via `node --experimental-strip-types` (Node ≥ 20). Only Lambda deploys bundle (esbuild, inside the `infra/*.sh` scripts). Most scripts load env from `.env` via `--env-file`, not the shell.

```bash
npm run build          # typecheck only (tsc --noEmit) — the closest thing to a test gate
npm run smoke          # Yahoo client smoke test
npm run mcp            # MCP server over stdio
npm run mcp:http       # exact Lambda code path, locally on :3939
npm run agent          # interactive agent REPL (Agent SDK)
npm run digest         # Tuesday digest; -- --week N for a specific week, -- --send to deliver
npm run eval           # score fixtures/golden set; -- --live also runs the real model
npm run runs           # browse the digest run archive; -- --pull copies records to data/runs/
npm run auth           # Yahoo OAuth bootstrap (writes .tokens.json)
npm run deploy         # MCP server → Lambda + API Gateway (idempotent)
npm run deploy:digest  # scheduled digest Lambda
npm run deploy:sync    # Sleeper players daily sync Lambda
npm run verify:remote  # end-to-end check of the deployed MCP endpoint
```

End-to-end MCP verification over real stdio (works for either provider):

```bash
FANTASY_PROVIDER=sleeper SLEEPER_LEAGUE_ID=<id> node --experimental-strip-types scripts/mcp-verify.ts
```

There is no unit-test framework; verification is `npm run build` + the smoke/verify/eval scripts above.

## Architecture

Three consumers sit on one provider-blind data layer:

- **Provider seam — `src/mcp/data.ts`** is the *only* file that knows two fantasy backends exist. `FANTASY_PROVIDER=yahoo|sleeper` picks `yahoo-data.ts` or `sleeper-data.ts` at startup; the re-export is typed `typeof yahoo`, so the Yahoo module's signatures ARE the provider contract and the compiler proves Sleeper implements it. Everything above this file (tools, digest, evals) must stay provider-blind — never import `yahoo-data`/`sleeper-data` directly from consumers.
- **MCP server** — `src/mcp/build-server.ts` defines five read-only tools (`get_roster`, `get_matchup`, `get_standings`, `get_transactions`, `get_week_results`) shared by two transports: stdio (`server.ts`) and stateless Streamable HTTP on Lambda behind API Gateway (`lambda.ts` + `http.ts`, static bearer token, sessions disabled, JSON response mode). Tool contracts live in `docs/mcp-tools.md`.
- **Interactive agent** — `src/agent/` on the Claude Agent SDK; the MCP server is its entire tool surface (all built-ins disallowed, which is what makes `bypassPermissions` safe — revisit if write tools ever appear). `pickModel()` tiers Haiku/Sonnet as a cost lever, not a router. `src/telegram/bot.ts` fronts it.
- **Digest** — `src/digest/` is deliberately a *workflow*, not an agent: `facts.ts` computes every number deterministically in code, `generate.ts` makes ONE Opus call with zod-schema-enforced output, `render.ts` does layout in code. It imports the data layer directly, not through MCP — MCP is a process boundary for agents; same-repo code calling functions doesn't need the protocol hop.

Cross-cutting invariants:

- **Errors are data.** Tool handlers never throw. Every response is `{status:"ok", data}` or `{status:"error", code, message}`, and error messages tell the agent what to *do* (retry, don't retry, run `npm run auth`). Codes are enumerated in `docs/mcp-tools.md`.
- **Trim at the tool boundary.** Providers return dozens of fields per entity; tools return only what an answer needs. Don't add response fields casually — digest quality and agent cost both ride on token-efficient tool output.
- **Grounding.** The digest model is forbidden to use numbers not present in the facts JSON; the agent prompt requires every stat to come from a tool result. Keep arithmetic in code, prose in the model.
- **Persistence** — `src/store.ts` (`JsonStore`): local files under `data/` in dev, S3 (`HISTORY_BUCKET`) on Lambda. Whole-JSON-blob reads/writes by key, zero-padded weeks so `sort()` is the query engine. ADR-0001 (`docs/adr/`) explains why not DynamoDB. Sleeper player names come from a trimmed map synced daily to S3 by `src/sleeper/sync-lambda.ts`.
- **Auth** — Yahoo OAuth tokens: `.tokens.json` locally, but after first deploy Secrets Manager (`muff/yahoo-tokens`) is the source of truth (Lambda refreshes and writes back; redeploys never overwrite an existing secret). The Agent SDK uses the Claude Code login; the digest's plain Anthropic SDK needs `ANTHROPIC_API_KEY` in `.env`. Sleeper needs no auth.
- **Observability** — every digest run is archived (facts + structured output + rendered text + cost) to the run archive and mirrored as a `MUFF_RUN` line in CloudWatch; archiving is non-fatal by design. `eval/fixtures/` are synthetic weeks pinning edge cases; `eval/golden/` is promoted real runs.

## Docs are the source of truth for design intent

Each subsystem has a design doc recording decisions and their reasoning: `docs/mcp-tools.md`, `docs/agent-design.md`, `docs/digest-design.md`, `docs/deploy.md`, `docs/observability.md`, `docs/sleeper-spike.md`, `docs/adr/`. When a change alters a documented decision, update the doc in the same change.
