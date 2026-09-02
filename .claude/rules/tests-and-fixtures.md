---
paths:
  - "eval/**/*"
  - "src/eval/**/*"
  - "scripts/eval.ts"
  - "**/fixtures/**/*"
---

# Eval & fixture conventions

These span `eval/` (data), `src/eval/` (checkers), and `scripts/eval.ts` (runner) — one convention set, three directories.

- **Fixture naming:** `eval/fixtures/<season>-wNN-<scenario-slug>.json`, zero-padded week (`w01`, not `w1`) so lexicographic sort is chronological. The slug names the edge case the fixture pins (`blowout`, `nailbiter-tie`), not the teams in it.
- **A fixture is a synthetic `WeekFacts` blob and must be internally consistent:** every derived field (margins, superlatives, power-ranking deltas, bench ordering) computed from its raw score tables, never typed by hand. This is what makes a groundedness failure always the digest's fault, not the fixture's.
- **Each fixture exists to pin one scenario.** Before adding one, say (in `eval/README.md`'s table) which edge case it freezes. Don't add fixtures that duplicate a scenario already covered.
- **Groundedness is the core check:** every number in a digest must appear in the facts JSON (`collectFactNumbers` in `src/eval/checks.ts`). New fact fields with numbers the model may cite must flow into that collection, or the checker will flag valid output.
- **`eval/golden/` is promoted real runs only** — never hand-written. Candidates come from `npm run runs -- --pull` into `data/runs/`; keepers get copied.
- **Before committing changes here:** `npm run build` (typecheck) and `npm run eval` (free, deterministic — the PR gate). `npm run eval -- --live` costs real API money; only for digest-prompt or schema changes.
- **Exit code is the CI contract:** the eval runner must exit non-zero on any failure. Don't add checks that only print warnings.
