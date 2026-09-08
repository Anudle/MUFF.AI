# Tuesday ingestion checklist — manual Yahoo transcription (MUFF-57)

**When this applies:** the Yahoo API is blocked (app re-approval pending, MUFF-50),
so once a week a human reads the league page and transcribes one file. Everything
downstream — fact derivation, the Opus call, rendering, evals, the archive — runs
unchanged. This is a documented degraded mode, not a scrape: the Yahoo *website*
is what a league member is entitled to read.

**Budget: 10–15 minutes.** Screens are listed in click order. Required steps come
first; the optional ones at the end are what you skip when short on time.

Contract: `src/ingest/weekly-fixture.ts` · Template: `fixtures/weekly/TEMPLATE.json` ·
Filled example: `fixtures/weekly/2025-w01.example.json` · Validator: `npm run fixture:validate`.

## 0. Before you open Yahoo (30 s)

```bash
cp fixtures/weekly/TEMPLATE.json fixtures/weekly/2026-w03.json   # zero-padded week
```

Fill the header: `source.ingested_by` (your name), `league`, `season`, `week`.
`week` is the week being recapped — the one that just finished, not the week
Yahoo's header now shows. Leave `ingested_at` null; the upload step stamps it.

Open the league on a laptop, not the app: `football.fantasysports.yahoo.com/f1/<league id>`.
The left-nav labels below are the 2025 web UI; if a label has moved, the URL path
after the league id is the stable part.

## 1. Standings — `…/standings` (3 min)

One screen, one row per team, top to bottom. Twelve rows for twelve teams.

| Fixture field | Yahoo column |
|---|---|
| `rank` | Rank (the row number) |
| `team` | Team — copy **exactly**, emoji and apostrophes included; every other screen is matched by this string |
| `wins` / `losses` / `ties` | W-L-T, split into three integers |
| `points_for` | Pts For (season total, 2 decimals) |
| `streak` | Streak, as shown: `W2`, `L1` (null if blank) |
| `manager` | *not on this screen* — optional; see step 5 |

## 2. Scoreboard — `…/scoreboard?week=N` (3 min)

Pick the recap week in the week selector (it defaults to the *current* week —
check the header says the week you want). One `matchups` block per card; six for
twelve teams.

| Fixture field | Yahoo |
|---|---|
| `teams[].team` | Team name on the card, exactly as in step 1 |
| `teams[].points` | The final total under each team |
| `teams[].projected` | The projected total, if the card still shows one after the games; otherwise `null` |

Do **not** type the winner, the margin, or who was closest — the derive computes
those, and the validator checks the winner against the Streak column you typed in
step 1.

## 3. Transactions — `…/transactions` (2 min)

Newest first, back to last Tuesday. Up to five is plenty; the digest only ever
mentions "notable adds/drops". Quiet week → `"transactions": []`.

| Fixture field | Yahoo |
|---|---|
| `type` | The row's kind: `add`, `drop`, `add/drop` (one move with both), `trade`, `commish` |
| `date` | `YYYY-MM-DD` |
| `players[].name` / `position` | As shown |
| `players[].action` | `add`, `drop`, or `trade` for each player in the row |
| `players[].from` / `to` | Team name, `FA` (free agents) or `W` (waivers); null if the row doesn't say |

## 4. Validate (10 s)

```bash
npm run fixture:validate fixtures/weekly/2026-w03.json -- --prev fixtures/weekly/2026-w02.json
```

Pass `--prev` whenever last week's fixture exists: it turns the record and
`points_for` checks from "plausible" into "exact". Read the *Derived facts* block
it prints — if the high scorer or the closest game isn't who you remember, a score
is mistyped. Fix and re-run until `Valid.` Then hand off to the upload step (MUFF-58).

**Required fields end here.** Steps 1–3 cover every field the schema demands.

## 5. Optional: managers (1 min, once a season)

`manager` on each standings row is a first name, used so the digest can say
"Lucas" instead of "LUCAS'S LUCKY LIONS". Yahoo shows it on each team's page
(click the team name) or in League → Members. Fill it once in week 1 and copy the
column forward; the validator accepts null.

## 6. Optional: bench totals + start/sit blunder (5–6 min)

From the scoreboard, open each matchup card. The full-roster view lists starters
then a **Bench** section with per-player points.

- `bench_points[]`: sum the bench column per team. Do all twelve or none — a
  partial list gives the digest a bench ranking that is missing people (the
  validator warns).
- `start_sit[]`: while you're there, note the one obvious blunder — a benched
  player whose points beat a starter he could legally have replaced (an RB on
  the bench vs. a W/R/T starter counts; vs. the QB does not). Type both players'
  names, points, the benched player's position and the starter's slot. The
  delta and "would it have flipped the result" are derived.

Skip this whole step when late: the digest simply omits bench roasts that week,
same as the Sleeper provider omits projection facts.

## What v1 deliberately leaves out

| Cut | Why |
|---|---|
| Full rosters (every player, slot, points) | ~150 cells for twelve teams — the entire time budget, for two facts (bench points, worst start/sit) that step 6 recovers in a fraction of the cells |
| `points_against` | Fetched on the API path, never used by a fact |
| Transaction `status` | Yahoo's page only lists completed moves; the value is always "successful" |
| Winner / margin / superlatives / deltas | Derived — see the failure-mode section |
| `previous_power_rankings` | Comes from the digest's own history store, not from Yahoo |

## Failure modes: what happens when a cell is mistyped

The fixture holds raw inputs so that most slips contradict a neighbouring cell.
What the validator catches, and what it can't:

| Slip | Caught by |
|---|---|
| Team name typo on the scoreboard | not in standings → error |
| Same team on two cards | error |
| A W-L column off by one | league wins ≠ losses, or games ≠ week number → error; exact delta with `--prev` |
| Score typed under the wrong team | winner no longer matches the Streak letter → error; `points_for` delta wrong with `--prev` |
| Wrong `points_for` | below this week's score, ≠ score in week 1, or ≠ last week + score with `--prev` → error |
| Three decimals in a score | warning |
| Bench total smaller than the benched player's points | error |
| A score that is wrong but consistent with everything else | **not caught.** With `--prev`, the only way a bad score survives is if `points_for` was mistyped by exactly the same amount. Without `--prev`, a plausible wrong score in week 2+ passes. This is why `--prev` is in the command above and not a footnote. |

Nothing downstream re-checks the numbers: the digest model is *forbidden* to
introduce numbers not in the facts, and the eval's groundedness check verifies
exactly that — so a wrong input is faithfully, confidently repeated. The
validator is the only gate. That is the honest answer to the ticket's debrief
question, and the reason the derive-and-print step exists: the human eyeballing
"closest game: X vs Y by 3.38" is the last check with any judgment in it.

## Verification log

- [x] Blank `TEMPLATE.json` fails with one error per required field (28 for the template as committed)
- [x] `2025-w01.example.json` passes and derives facts identical to `eval/fixtures/2025-w01-blowout.json`
- [x] Every required field above has a source screen (steps 1–3)
- [ ] Timed run against the live Yahoo league page — pending; record the minutes here
