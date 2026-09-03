---
name: debrief
description: End-of-day CCA-F debrief. Writes a dated entry to docs/debrief/ from today's git diff and the exam task-statement map.
context: fork
allowed-tools: [Read, Write, Bash(git diff *), Bash(git log *)]
argument-hint: "[task-statement ids touched today, e.g. 3.1 2.4]"
---

# End-of-day CCA-F debrief

Write today's study debrief to `docs/debrief/YYYY-MM-DD.md` (today's date). One entry per build day; if the file already exists, append a `## Addendum` section instead of overwriting.

Arguments: `$ARGUMENTS` — the exam task-statement ids touched today (e.g. `3.1 2.4`). If none were given, infer them from the diff and say you inferred them.

## Steps

1. Look at today's work:
   - `git log --oneline main..HEAD` and `git log --oneline --since=midnight` for what landed today.
   - `git diff main...HEAD --stat` then the full diff for the files that matter. If the branch is already merged, use `git diff HEAD~1` on the merge/squash commit instead.
2. Answer the three debrief questions, grounded in that diff — no generic exam-guide prose:
   - **Task statement touched:** which CCA-F task statement(s) today's change exercises, and the one-line mapping from artifact → statement.
   - **Bait answer:** the plausible-but-wrong answer an exam question on this topic would offer, and why today's build shows it's wrong.
   - **What a teammate wouldn't know:** the non-obvious thing you only learned by building it (a constraint, a gotcha, a default that surprised you).
3. Write the entry:

```markdown
# Debrief — YYYY-MM-DD

**Task statements:** <ids>
**What shipped:** <one line, link the PR/commit>

## Task statement touched
...

## Bait answer
...

## What a teammate wouldn't know
...
```

Keep it under a page. The diff is evidence, not content — quote at most a few lines of it.
