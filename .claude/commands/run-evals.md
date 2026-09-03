---
description: Run the digest eval suite and summarize pass/fail
allowed-tools: [Bash(npm run eval*), Read]
argument-hint: "[--live to also run the real model]"
---

Run `npm run eval $ARGUMENTS` and report: how many fixtures passed/failed, and for each failure the fixture name and the one-line reason. If a failure looks like a groundedness violation (a number not present in the facts JSON), say so explicitly — that's the invariant the suite exists to protect.
