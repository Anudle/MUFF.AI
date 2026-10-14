# League-history retrieval (RAG) — design decisions (MUFF-63)

Modules: `src/rag/{chunk,embed,index}.ts` · Build: `npm run rag:build` ·
Query: `npm run rag:search -- "…"` · Tool: `search_league_history` (`docs/mcp-tools.md`)

```
 run archive (S3/data)      chunk.ts            embed.ts (Titan v2)        index.ts
 one record per week   →   headline / recap /  →   256-d unit vectors   →   rag/index.json
 + docs/league-rules.md    per-team ranking line                              dot-product top-k
                                                                                    ↓
                                                              search_league_history (MCP)  → agent
                                                              (Day 4: digest "callbacks" step)
```

## Why RAG here at all — the honest answer

The posting MUFF exists to rehearse lists tool-calling agents, prompt chaining,
memory, and RAG. MUFF had the first three; this is the fourth, built as small
as it can honestly be. It is **not** a cost play: a whole 17-week season of
digests is ~14k tokens, about $0.07 of Opus input per run if simply pasted
into the prompt. What retrieval buys instead:

- **Targeted callbacks.** The digest's Day 4 step asks for 3 chunks *about
  the teams in this week's matchups*, not a season's worth of prose the model
  has to scan — which is also where a "3rd week in a row" fabrication would
  come from. Fewer, relevant chunks = fewer places to hallucinate a pattern.
- **Traceable claims.** A retrieved chunk carries `{season, week, section,
  team, source}`. The groundedness checker can demand that every historical
  claim points at one. Pasted context can't be audited that way.
- **Growth.** Seasons accumulate; the stuffing budget doesn't.

## Decisions

**Corpus: one digest per week, delivered beats dry.** The archive keeps every
run — rehearsals, retries, mock weeks — but the league only read one digest
per week. `selectCorpusRuns` keeps the delivered record (newest on ties) and
`loadCorpus` drops `provenance.source === "synthetic"` so an eval fixture
replayed through the pipeline can never become "history". The current
corpus is the 2025 w1 transcribed week plus every live 2026 week.

**Chunking: by section, not by token window.** A digest is already written
in self-contained units — headline, recap, one line per team in the power
rankings — and a callback lives inside exactly one of them. A 512-token
window would glue the end of one team's line to the start of the next and
make a chunk "about" two teams. Section chunks keep one subject per chunk
and let the metadata say which subject (`team`, `rank`). Each chunk's text
is prefixed with `Week N (season)` so the vector itself carries *when*;
the structured fields carry it for the checker. ~16 chunks a week, 96 today.

**Embeddings: Amazon Titan Text Embeddings v2, 256-d, normalized.**
Chosen over Voyage (Anthropic's embeddings partner) on operational surface,
not quality: the index is in the MUFF bucket, the Lambdas run under IAM
roles in the same account, and the Dev user could already invoke the model —
one `bedrock:InvokeModel` statement versus a new vendor account, a new
secret, and a key to rotate. 256 dimensions instead of 1024 because the
corpus is tiny and the queries short; `normalize: true` so cosine is a dot
product. Region via `BEDROCK_REGION` (default `us-east-1`).

**Index: one JSON blob in the existing store, brute-force search.** No
vector database. `rag/index.json` is chunks + vectors; `rag/chunks.json` is
the readable corpus dump. A dot product over a few hundred (or a few
thousand) 256-d vectors is sub-millisecond, and the index is derived data —
rebuilt from the archive by `npm run rag:build` whenever a week lands. A
vector DB would add a service to deploy, pay for, and keep in sync with S3 to
make an already-instant query instant. The blob is cached per process, so a
warm Lambda or a long-lived stdio server reads it once.

**`k` defaults to 5, capped at 10.** A chunk is ~40 tokens; 5 chunks is
~200 tokens of evidence, which is the whole point versus stuffing.

**Rules live in markdown, one chunk per `##`.** `docs/league-rules.md`
(scoring, roster, playoff format) is hand-written — nothing in the APIs
states it the way the league understands it. `chunkRules` is skipped when
the file is absent, so the index builds without it.

## Observed quality (2026-10-14, 96 chunks)

Scores cluster in 0.35–0.45 for good hits and under 0.2 for noise; the
absolute value is not meaningful across queries, the ordering is. Entity
queries are sharp ("Did Barry ever win a game?" → the Baker Mayfields
ranking lines for weeks 5 and 1). Slang is weaker: "worst beat of the
season" returns the week-5 and week-1 recaps (the 73-point blowout, the
"bloodbath"), with Barry's "robbed by the schedule" line outside the top 3.
Re-ranking and hybrid (keyword + vector) search would fix that and are
explicitly out of scope — if a Day 4 callback needs it, the debrief says why.

## Deploying it (Day 3 → 4, hands-on IaC)

The stdio server and `npm run rag:search` work from a laptop today. For the
deployed MCP Lambda and the digest Lambda to search, each role needs
`bedrock:InvokeModel` on `arn:aws:bedrock:<region>::foundation-model/amazon.titan-embed-text-v2:0`
and `s3:GetObject` on `rag/*` in `HISTORY_BUCKET` (the MCP Lambda does not
currently read the bucket at all). That is Anu's IaC to write, per the
October plan. The deployed index is built with
`HISTORY_BUCKET=muff-digest-history-<acct> npm run rag:build` — from the
deployed archive, never from local dry runs.

## Not built (and why not)

Re-ranking, hybrid search, a vector database, framework retriever nodes.
None of them pays for itself under ~10k chunks, and every one adds a
component to explain in the deployment narration.
