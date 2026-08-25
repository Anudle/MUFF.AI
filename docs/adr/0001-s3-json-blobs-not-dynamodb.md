# ADR-0001: Persist digest state as JSON blobs in S3, not DynamoDB

**Status:** Accepted (retroactive — this records the decision already embodied
in `src/digest/store.ts`, made incrementally across MUFF-38/43/16)

## Context

Three things need to survive between weekly digest runs, because a Lambda
container's filesystem evaporates between invocations:

1. **Power-ranking history** — one small JSON object, read and written once a
   week, so movement arrows reflect what was actually *published* last week.
2. **The run archive** — one immutable record per digest run (facts + model
   output + rendered text + cost), the raw material for every MUFF-16 eval.
3. Nothing else. No user queries, no concurrent writers, no partial updates.

Access pattern, fully enumerated: `read(key)`, `write(key)`, `list(prefix)` —
17-ish times a season, single writer, whole-object reads. Run records carry the
complete `WeekFacts` and can plausibly reach tens of KB.

## Decision

One `JsonStore` interface with two implementations behind an env-var seam:
local files under `data/` in dev, S3 objects in `HISTORY_BUCKET` on Lambda.
Keys are paths (`digest-history.json`, `runs/2025-w07-<stamp>.json`), week
zero-padded so a plain `sort()` is the query engine.

## Why not DynamoDB

DynamoDB earns its complexity when you have items to *query* — key conditions,
secondary indexes, conditional writes, many small concurrent updates. This
workload has none of that:

- **The access pattern is `GetObject` by known key.** Every "query" we run
  ("all runs, in order") is a prefix list plus a sort. Paying for a query
  engine to not query is negative engineering.
- **Item size.** DynamoDB caps items at 400 KB. A run record embeds full
  `WeekFacts` (14 rosters' worth of derived facts) plus the digest and
  rendered text — comfortably under today, but a cap you must *think about*
  forever. S3 objects make the whole class of problem not exist.
- **The eval harness wants files.** `npm run runs -- --pull` copies records to
  disk and the eval suite reads JSON files; S3 objects and local files are the
  same shape. DynamoDB would add a marshalling layer solely to reconstruct the
  blob we started with.
- **Ops surface.** The bucket already exists for the deployed digest (MUFF-43),
  IAM is two actions (`GetObject`/`PutObject` + `ListBucket`), and cost is
  effectively zero at 18 writes a season. A table adds capacity mode choices,
  a second IAM policy, and a second thing to explain in `infra/`.

**The honest trade-off:** S3 gives no conditional writes and no atomic
read-modify-write. `digest-history.json` is read-modify-write — under
concurrent writers that's a lost-update bug. We accept it because the writer
is one EventBridge-scheduled Lambda firing once a week; if a second writer
ever appears (a backfill job racing the scheduled run), that is the signal to
revisit — first stop would be S3 conditional writes (`If-None-Match`) on the
immutable run records and a rethink of the mutable history object, not
necessarily DynamoDB.

## Consequences

- Dev/prod parity is one env var; every persistence consumer (history,
  archive, future eval outputs) rides the same seam and gets S3 for free.
- The archive doubles as the golden dataset with zero export tooling — eval
  reads the same JSON the Lambda wrote.
- Anything that later *does* need real queries ("all runs where cost > X")
  gets grep/jq until the data outgrows a laptop, which a fantasy league's
  season of digests never will.
