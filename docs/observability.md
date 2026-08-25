# Cost tracking + the run archive (MUFF-16, lite slice)

`npm run digest` and the scheduled Lambda now price every run and keep it.

```
npm run runs                                          # local archive
HISTORY_BUCKET=muff-digest-history-<acct> npm run runs # the deployed one
npm run runs -- --pull                                 # copy records into data/runs/
```

## Why this landed before kickoff, not with the rest of MUFF-16

KR1 (MUFF-45) is graded on two things this code produces and nothing else can
backfill: **cost-per-run logged across 8+ consecutive weeks**, and a **golden
set of 20+ digest outputs**. Both are byproducts of the season actually
running. The first scheduled digest fires Tue Sept 15; every Tuesday that
passes without instrumentation is a week of evidence that cannot be
reconstructed later — Yahoo will still serve the stats, but not the model
output, not the token counts, and not what the run cost on the day.

So the *measurement* ships now and the *scoring* ships in October. The
expensive half (groundedness checks, LLM-as-judge, regression gate in CI) is
still MUFF-16 proper; it just gets to run against a full season of real
records instead of a cold start.

## What a run record holds

`runs/{season}-w{week}-{timestamp}.json`, one immutable object per run:

| Field | Why it's there |
|---|---|
| `facts` | The exact model **input**. Freeze it and you can re-run a new prompt against a real week and diff — that's the regression test. |
| `digest` | The exact structured **output**, pre-render. Groundedness scoring reads it against `facts`. |
| `text` | What the league actually saw. Format/length checks run on this. |
| `cost` | Model, token counts, USD. Sums to the season number. |
| `duration_ms`, `delivery_attempted`, `run_id` | Operational: did it go out, how slow, which invocation. |

Week is zero-padded in the key so `w07` sorts before `w16` — the archive is
meant to be read in order by a `sort()` and nothing more clever.

## Two independent sinks, on purpose

**S3** holds the full records — big, structured, the golden set.
**CloudWatch** gets one `MUFF_RUN` JSON line per run — small, queryable, no
S3 round-trip to answer "what has this cost me":

```
fields @timestamp, week, cost_usd, duration_ms, delivered
| filter tag = "MUFF_RUN"
| sort @timestamp asc
```

They overlap deliberately. If an S3 write fails the cost number still lands in
logs, and vice versa — and archiving is explicitly non-fatal, because a failed
evidence write must never cost the league its Tuesday digest. The message is
the product; the archive is evidence.

## Pricing

Rates live in `src/digest/cost.ts`, USD per million tokens, first-party
Anthropic API pricing. Cache multipliers (write 1.25x input, read 0.1x) are
wired but always zero today — the digest makes one call with no repeated
prefix, so there is nothing to cache. An unknown model id yields
`cost_usd: null` with the token counts still recorded: the run is never
silently priced at zero.

A representative week (18.5k in / 2.1k out on `claude-opus-4-8`) prices at
about **$0.15**, so a 17-week season is roughly **$2.50** — but that's an
estimate until real runs land in the table. `npm run runs` prints the
projection from actual mean cost.

## The storage seam

`src/digest/store.ts` is one `JsonStore` keyed by path: local `data/` in dev,
`HISTORY_BUCKET` in S3 on Lambda. Power rankings (MUFF-38/43) and the run
archive both ride it. Same reasoning as the MUFF-39 token store — a Lambda
container's filesystem evaporates between invocations, and the alternative
(DynamoDB) buys nothing for one small JSON blob written once a week.

That "S3 vs. a real database" call is the ADR KR1 asks for:
[ADR-0001](adr/0001-s3-json-blobs-not-dynamodb.md).

## The eval suite

`npm run eval`, gated in CI by `.github/workflows/eval.yml` on every PR.

The eval pyramid, cheapest layer first: **rule checks** (free, exact, every
PR) → **LLM-as-judge** for tone/quality (costs a call, not built yet) →
**humans** (the group chat). The rule layer is `src/eval/checks.ts`:

- **Groundedness** — harvest every number the facts contain (including inside
  strings: records `5-2`, streaks `W3`, transaction summaries), then demand
  every number in the model's prose appears in that set, 1-decimal rounding
  allowed. A cited stat with no source fact is a hallucination, full stop.
- **Format** — 3-5 trash-talk lines, each citing a number; one game note per
  matchup; power rankings covering all teams with ranks 1..N exactly once; no
  model-authored movement arrows (render.ts owns those); empty waiver watch
  when the facts show no transactions; rendered text within Telegram's 4096.

What it scores, in order:

1. **Checker self-test** — the four synthetic `WeekFacts` in `eval/fixtures/`
   (a blowout week, a nail-biter with a tie, a no-transactions week, a
   start/sit-blunder week) each get a programmatically grounded digest that
   must pass and a corrupted one — one number swapped for a value nowhere in
   the facts — that must fail. A checker that never flags anything looks
   identical to one that works, so CI proves it catches a planted
   hallucination on every PR. No keys, no network.
2. **Archived run records** — everything in `data/runs/` (via
   `npm run runs -- --pull`) and `eval/golden/`. Empty until the season
   starts; this is where real Tuesdays get graded.
3. **`npm run eval -- --live`** — the golden-dataset eval proper: run the
   actual `generateDigest` call against each frozen fixture and rule-check the
   real model output, cost printed per fixture. Local/manual for now; costs
   API money by design.

## Still open in MUFF-16

- LLM-as-judge for tone, on top of the rule checks.
- Golden records: promote real archived runs into `eval/golden/` once the
  season produces them, and consider a scheduled `--live` CI job with
  `ANTHROPIC_API_KEY` as a repo secret.
- Latency/failure alerting (a Tuesday that doesn't fire is currently only
  visible as a failed invocation in CloudWatch).
