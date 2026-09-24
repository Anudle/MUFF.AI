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

Two refinements from the Sept 10 dry run (`docs/dry-run-2026-09-10.md`, MUFF-60):

- **"Never do arithmetic" is its own prompt rule.** Two of three gate failures
  were *correct* subtractions of real facts ("lost by 39"). Provenance, not
  truth, is the invariant, so the prompt now says a number the model computed
  itself is a violation even when right, and that every number is written as
  digits (the checker maps number words too, but the rule should be visible
  to the model, not just to the checker).
- **The rule gate runs inline, with one retry.** `run.ts` scores every
  generation with `src/eval/checks.ts` before archiving; a failure regenerates
  once, and the second attempt ships regardless — a late digest is worse than
  an imperfect one, and the archive records both verdicts (`gate.attempts`)
  so the eval can see what happened. Cost doubles on a retry, which is why the
  cap is two, not "until it passes".

The system prompt derives the league name and team count from the facts
(`systemPrompt(facts)`) rather than hard-coding them: the dry-run mock, keyed
"(dry-run mock)" in its league name, would otherwise have been introduced as
the real league.

## Structured output: schema for shape, prompt for content

`client.messages.parse()` + `zodOutputFormat(DigestSchema)` →
`output_config.format` JSON-schema enforcement. The schema guarantees the
digest always has its sections (headline, recap, power rankings) with the
right types — so `render.ts` can never break on a malformed response. What the
schema *can't* enforce (that the recap's roast cites a real number) lives in
the system prompt. Know which layer owns which guarantee.

## Three sections, not six

The first two live weeks shipped headline + recap + a game note per matchup +
3-5 trash-talk lines + rankings + waiver watch: ~3,500 characters, and it read
like a report, not a group-chat message. Week 3 cut it to headline, recap and
power rankings. The recap carries the week's story and its one screenshot-worthy
roast; the ranking comments (one line per team) are where everyone else gets
theirs — that section already *was* the trash talk. Game notes duplicated the
Yahoo scoreboard everyone has open anyway, and waiver watch narrated
transactions nobody asked about. `recent_transactions` stays in the facts (the
model can still cite a pickup in a ranking comment) but has no section of its
own.

Eval consequence: the golden records from weeks 1-2 carry the old six-field
digest. They still score, because the checker only reads the three fields the
shapes share — the extra fields are ignored, and the format checks that
depended on them (`game_notes_count`, `trash_talk_*`, `waiver_watch_grounded`)
are gone with the sections.

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

### Getting the fixture to the Lambda (MUFF-58)

The fixture is a **provider**, not a special case. `FANTASY_PROVIDER=fixture`
selects `src/mcp/fixture-data.ts`, which implements the same contract as the
Yahoo and Sleeper modules (the compiler checks it, via `typeof yahoo` in
`data.ts`) by reading hand-transcribed weeks from the blob store. Nothing in
`facts.ts`, `run.ts` or the Lambda knows the difference — that is the
"no code changes downstream" acceptance criterion, and the reason a
human-in-the-loop source lives behind the seam instead of an `if` in the
digest. Manual mode is a named value, never a fallthrough: an unrecognised
`FANTASY_PROVIDER` still means Yahoo.

- **Key convention** — `fixtures/weekly/<season>-wNN.json` in the one blob
  bucket (`HISTORY_BUCKET`; `data/` locally), mirroring the repo's own
  `fixtures/weekly/`. The key is a pure function of (season, week), so the
  Lambda derives it. There is deliberately **no "latest" pointer** to keep in
  sync: zero-padded weeks make a sorted listing chronological (the run archive
  uses the same trick), so the newest key *is* the latest completed week, and
  `current_week` is reported as latest+1 so `gatherWeekFacts()`'s
  "last completed week" arithmetic lands on it unchanged. `FIXTURE_SEASON`
  pins a season; otherwise the newest season present wins.
- **Upload is the gate** — `npm run fixture:upload <path>` runs the MUFF-57
  validator in-process (schema, then cross-field checks against last week's
  fixture *fetched from the same store*, so exact deltas are checked without
  remembering `--prev`), refuses on any error before touching S3, refuses to
  overwrite an existing week without `--force`, and stamps
  `source.ingested_at` into both the uploaded object and the local file so the
  committed copy matches what the Lambda read.
- **Provenance** — every `WeekFacts` now carries
  `provenance: { source, ingested_by, ingested_at }` (`source` is
  `yahoo`/`sleeper` for API weeks, `manual` for fixtures, `synthetic` for eval
  fixtures). It rides into the run archive and the `MUFF_RUN` log line, and is
  **stripped before the model sees the facts** and skipped by the
  groundedness checker — the league must not be able to tell a transcribed
  week from an API week, and an ISO timestamp is a bag of numbers the model
  must not be tempted to cite. Why the extra field is worth it: without it a
  season's run archive is a set of digests with no way to say which weeks were
  API-sourced and which were typed by a human at 7am — so a quality dip in the
  evals, or a cost difference, could not be attributed; and once Yahoo access
  returns, nothing would flag which archived weeks are the ones whose only
  validation was the transcriber's eyes.
- **Deploy-time switch** — `deploy-digest.sh` passes `FANTASY_PROVIDER` from
  `.env` (default `yahoo`) and grants the Lambda `GetObject` on `fixtures/*`
  plus a prefix-scoped `ListBucket`. Flipping mode is a redeploy, not a
  runtime condition, so a Tuesday never silently changes source.

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
