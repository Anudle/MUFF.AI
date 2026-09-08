# Tuesday digest pipeline — design decisions (MUFF-38)

Pipeline: `src/digest/{facts,generate,render}.ts` · Runner: `npm run digest`
`npm run digest -- --week 15` for a specific week · `--send` delivers to `TELEGRAM_CHAT_ID`.

## Workflow, not agent — the deliberate contrast with MUFF-13

The interactive agent (MUFF-13) is an **agent**: the question is unknown until it
arrives, so the model must decide which tools to call. The digest is the
opposite: the same four data pulls every Tuesday, the same output shape every
week. Fixed steps + known shape = **workflow** — deterministic code around one
model call. (CCA-F: "use the simplest tier that meets the need"; agents are for
open-ended tasks, workflows for prescribed ones.)

```
gatherWeekFacts()            generateDigest()          renderDigest()
 results/standings/    →      ONE Opus call with   →    layout in code    →  Telegram
 transactions/rosters         JSON schema output         (*bold* works in
 → derived stats in CODE                                 TG + WhatsApp)
```

## Grounding: compute in code, joke in the model

The differentiator vs. last season's generic insult bot. The model is never
asked to do arithmetic or read raw rosters — `facts.ts` derives everything
deterministically (bench points, worst start/sit incl. legal-position check and
would-it-have-flipped-the-result, closest game, projection misses), and the
prompt forbids any number not present in the facts JSON. Hallucinated stats are
structurally hard: the model's only job is prose around pre-computed truth.

## Structured output: schema for shape, prompt for content

`client.messages.parse()` + `zodOutputFormat(DigestSchema)` →
`output_config.format` JSON-schema enforcement. The schema guarantees the
digest always has its sections (headline, recap, game notes, trash talk, power
rankings, waiver watch) with the right types — so `render.ts` can never break
on a malformed response. What the schema *can't* enforce (that each roast cites
a real number) lives in the system prompt. Know which layer owns which
guarantee.

Rendering is code, not model output: layout consistency shouldn't depend on
sampling. `*bold*` renders in both Telegram (`Markdown` parse mode) and
WhatsApp, which is the copy-paste/forwarding story.

## Model: Opus 4.8, no tiering

The digest is the flagship artifact, runs ~17 times a season, and a run costs
cents. The Haiku/Sonnet tiering logic (docs/agent-design.md) exists to cheapen
high-frequency interactive traffic; applying it to a weekly showcase output
would optimize the wrong thing.

## Week resolution

By Tuesday, Yahoo's `current_week` has advanced past the games being recapped —
so with no `--week` arg the pipeline recaps `current_week - 1` (or the final
week of a finished season). Explicit `--week N` overrides for backfills.

## League-wide rosters (data-layer extension)

`getLeagueRosters(week)` in `src/mcp/yahoo-data.ts`: one Yahoo call per team,
batched 4 at a time (Yahoo 999-rate-limits are real). `resolveLeague()` now
carries the full team list. `get_roster` (the MCP tool) stays my-team-only —
the privacy-ish scoping of the interactive tool surface is unchanged; the
digest imports the data layer directly.

Which raises the question: why doesn't the digest go through the MCP server?
Because MCP is a *process boundary for agents* — its value is tool discovery +
routing for a model. The digest is code calling functions in the same repo;
adding a protocol hop would be ceremony. When MUFF-39 splits deployment, the
Lambda digest still bundles the data layer directly.

## Manual ingestion path (MUFF-57 / MUFF-50 degraded mode)

While the Yahoo API is blocked, a human transcribes one file per week
(`fixtures/weekly/<season>-wNN.json`, contract in `src/ingest/weekly-fixture.ts`,
click-order guide in `docs/ingestion-checklist.md`) and the pipeline runs
unchanged from `deriveWeekFacts()` onward.

Two decisions:

- **`facts.ts` is split into fetch and derive.** `gatherWeekFacts()` pulls the
  four provider payloads; `deriveWeekFacts(week, inputs)` is pure. The manual
  path maps its fixture onto the same provider shapes (`toWeekInputs`) and calls
  the same derive, so there is exactly one implementation of "closest game".
- **The fixture holds raw inputs, not `WeekFacts`.** A hand-typed margin would
  be the one number in the pipeline nothing computed; and raw inputs are
  redundant with each other (points_for grows by this week's score, wins+losses
  equals the week, the winner's streak starts with W), which is what lets
  `npm run fixture:validate` catch a transcription slip. `--prev <last week>`
  makes those checks exact. Derived numbers typed by hand have no witness.

What the human types is kept to what Yahoo shows on three screens (standings,
scoreboard, transactions); rosters are cut to an optional bench total and one
optional start/sit pair per team, from which the derive still computes the
delta and the flipped-result verdict. The eval's groundedness check does not
re-verify inputs — a wrong score is faithfully repeated — so the validator is
the only gate, and it prints the derived superlatives for a last human look.

## Auth

`generate.ts` uses the plain Anthropic SDK → needs `ANTHROPIC_API_KEY` in
`.env` (the Claude Code subscription login only feeds the Agent SDK). Same key
goes to Secrets Manager for the Lambda in MUFF-39.

## Deferred to MUFF-39

- EventBridge schedule (Tue ~7am MT, in-season) triggering a Lambda whose
  handler body is exactly `scripts/digest.ts`'s gather → generate → render →
  send sequence.

## Cost + archiving

Every run is priced and archived — see `docs/observability.md` (MUFF-16).

## CCA-F mapping

- **Agentic architecture** — the workflow-vs-agent decision itself.
- **Structured output** — real `output_config.format` schema enforcement;
  schema-vs-prompt division of guarantees.
- **Context management** — facts JSON is the only model input: small, curated,
  pre-digested; no raw API payloads in the context window.
