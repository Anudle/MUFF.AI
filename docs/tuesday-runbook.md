# Tuesday runbook (MUFF-60)

The digest Lambda fires **Tuesday 7:00 America/Denver** (`muff-digest-tuesday`,
payload `{}` = "last completed week", delivers to `TELEGRAM_CHAT_ID`). This is
the half-asleep checklist: what to check before it fires, what to do when it
doesn't. Every command runs from the repo root with `.env` in place.

`<N>` below is the NFL week being recapped (the one whose Monday game just ended).

## Monday night (or Tuesday by 6:30 MT) — go/no-go

1. **Yahoo is up and the tokens work.**
   ```bash
   npm run smoke
   ```
   Prints the league and `✅`. Anything else → **degraded mode** (below).

2. **Yahoo has advanced to week N+1.** The `{}` payload recaps
   `current_week - 1`; if Yahoo still says week N at 7:00, the Lambda recaps
   the *previous* week again and sends it.
   ```bash
   node --experimental-strip-types --env-file=.env -e 'import("./src/mcp/yahoo-data.ts").then(async (y) => { const l = await y.resolveLeague(); console.log({ current_week: l.current_week, empty_payload_recaps: l.current_week - 1 }); })'
   ```
   Not advanced yet → check again after 6:30; if still stuck, let the schedule
   fire anyway only if `empty_payload_recaps` is N. Otherwise skip to
   **"Lambda ran the wrong week"** and invoke manually with the week set.

3. **Dry run locally on the real data** (costs ~7¢, never sends, does write
   `data/digest-history.json` — untracked, harmless).
   ```bash
   npm run digest -- --week <N>
   ```
   Read the text once. `Gate: PASS` is the go signal. `Gate: FAIL after 2
   generation(s)` means both attempts tripped the rule gate — read the listed
   check, and if it is a real hallucination rather than a rank-range integer,
   it will very likely recur on the Lambda: fix the prompt before 7:00 or be
   ready to run manually.

4. **The Lambda is on the right provider and code.**
   ```bash
   aws lambda get-function-configuration --function-name muff-digest --region us-east-2 --query '{LastModified:LastModified,Provider:Environment.Variables.FANTASY_PROVIDER}'
   ```
   `Provider` must be `yahoo` (or `fixture` if you are in degraded mode on
   purpose). If `LastModified` predates your last merged pipeline change:
   `npm run deploy:digest`.

## Tuesday after 7:00 MT — did it go out?

```bash
aws logs filter-log-events --log-group-name /aws/lambda/muff-digest --region us-east-2 --start-time $(( $(date +%s) - 3600 ))000 --filter-pattern MUFF_RUN --query 'events[].message' --output text
```

One JSON line: `week: N`, `delivered: true`, `source: "yahoo"` (or `"manual"`),
`gate_pass: true`, `generations: 1`. Then archive the evidence:

```bash
HISTORY_BUCKET=muff-digest-history-998716768903 npm run runs -- --pull && npm run eval
```

The new record must PASS. Promote it to `eval/golden/` if the week pins
something new (see `eval/README.md`).

### No MUFF_RUN line

The invocation failed (that is the design: `sendMessage` throws, nothing
catches). Find out why, then run it by hand — this **delivers**:

```bash
aws logs tail /aws/lambda/muff-digest --region us-east-2 --since 2h | grep -v INFO
aws lambda invoke --function-name muff-digest --region us-east-2 --cli-read-timeout 320 --payload '{"week": <N>}' --cli-binary-format raw-in-base64-out /tmp/digest-out.json && cat /tmp/digest-out.json
```

Common causes: Yahoo 999 / token refresh failed (→ degraded mode), Anthropic
key, Telegram bot removed from the group (`npm run telegram:chats`).

### Lambda ran the wrong week

`MUFF_RUN` says `week: N-1`: Yahoo had not advanced. Re-run with the week
pinned (delivers a second message; the earlier one is a stale recap, say so in
the chat):

```bash
aws lambda invoke --function-name muff-digest --region us-east-2 --cli-read-timeout 320 --payload '{"week": <N>}' --cli-binary-format raw-in-base64-out /tmp/digest-out.json
```

### Gate failed on the delivered run

`gate_pass: false` means both generations tripped a rule and the second one
shipped anyway (a late digest is worse than an imperfect one). Pull the record
and read `gate.attempts[*].failed`. If it is a genuine bad number, correct it in
the chat by hand; then fix the prompt in `src/digest/generate.ts` and add the
record to `eval/golden/` so the regression stays caught.

## Degraded mode — Yahoo is down

Target: fixture uploaded and Lambda flipped **before 7:00 MT**; otherwise
invoke manually after.

1. Transcribe the week from the Yahoo app into
   `fixtures/weekly/<season>-w<NN>.json` (zero-padded), following
   `docs/ingestion-checklist.md`. Scores are whole numbers; only projections
   carry decimals.
2. Validate against last week so the deltas are exact:
   ```bash
   npm run fixture:validate fixtures/weekly/<season>-w<NN>.json -- --prev fixtures/weekly/<season>-w<NN-1>.json
   ```
   Errors block; fix the typo it names and re-run. Warnings are for you to
   read, not to silence. Last week's file is in the bucket if not local:
   `aws s3 cp s3://muff-digest-history-998716768903/fixtures/weekly/<season>-w<NN-1>.json fixtures/weekly/`.
3. Upload (validates again, stamps `ingested_at`, refuses on any error or an
   existing week):
   ```bash
   HISTORY_BUCKET=muff-digest-history-998716768903 npm run fixture:upload fixtures/weekly/<season>-w<NN>.json
   ```
4. Flip the Lambda and prove it reads the fixture:
   ```bash
   FANTASY_PROVIDER=fixture npm run deploy:digest
   aws lambda invoke --function-name muff-digest --region us-east-2 --cli-read-timeout 320 --payload '{"week": <N>, "dry_run": true}' --cli-binary-format raw-in-base64-out /tmp/digest-out.json && cat /tmp/digest-out.json
   ```
   Expect `source: "manual"`, `ingested_by: "<you>"`, `gate_pass: true`.
5. Let the schedule fire (or invoke with `{"week": <N>}` to send now).
6. **Exit** as soon as `npm run smoke` passes again:
   `FANTASY_PROVIDER=yahoo npm run deploy:digest`. Uploaded fixtures can stay —
   the Yahoo provider never reads them.

### Lambda doesn't pick the fixture up

`MUFF_RUN` says `source: "yahoo"` or the invoke errors with a fixture message:

- `aws lambda get-function-configuration … --query Environment.Variables.FANTASY_PROVIDER` — must be `fixture`; if not, step 4 didn't run from a shell with the variable set (a shell export beats `.env`).
- `aws s3 ls s3://muff-digest-history-998716768903/fixtures/weekly/` — the newest key is the week it will serve; a fixture keyed to the wrong season or week sorts wrong.
- The fixture provider refuses `get_roster`/`get_matchup` by design; the digest never calls them, so that error means an agent, not the digest.

## Game of the Week poll (MUFF-40)

The `MUFF_RUN` line carries `poll_posted` (this week's poll went out after the
digest) and `poll_votes` (how many voted in the poll this run closed; `null`
when there was none).

- **`poll_posted: false` on a delivered run** — either Yahoo had no
  projections for the upcoming week yet (off-season / final week: expected),
  or `sendPoll` failed after the digest was delivered: look for "Game of the
  Week poll failed" in the log. The digest is fine; post the poll by hand if
  you care.
- **No receipts in the recap although people voted** — the closing run
  couldn't `stopPoll` ("Could not close week N poll" in the log; a poll
  already closed by hand 400s). The tally is never lost: close it in Telegram
  and the counts stay visible on the message.
- **Rehearsing with `npm run digest` on Monday** never closes the live poll
  (only a delivering run does), so the rehearsal has no receipts sentence.
  That is expected, not a bug.

