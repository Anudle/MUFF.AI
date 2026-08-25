# eval/ — the golden dataset (MUFF-16)

**`fixtures/`** — four synthetic `WeekFacts` snapshots, hand-designed while
Yahoo API access was under review, each freezing a scenario the digest must
handle:

| Fixture | Scenario it pins down |
|---|---|
| `2025-w01-blowout` | 85-point blowout, cold start (`previous_power_rankings: null`) |
| `2025-w05-nailbiter-tie` | 0.36 margin, plus a tie (`winner: null`) |
| `2025-w09-quiet-week` | zero transactions — waiver watch must stay empty |
| `2025-w11-start-sit-blunder` | 31.7-point bench blunder that flipped a result |

All derived fields (margins, superlatives, deltas, bench ordering) were
computed from the raw score tables, not typed by hand — the fixtures are
internally consistent, so a groundedness failure against them is always the
digest's fault, never the fixture's.

**`golden/`** — real archived run records promoted to permanent test cases.
Empty until the season produces them; `npm run runs -- --pull` fetches
candidates into `data/runs/`, and the keepers get copied here.

`npm run eval` scores everything (see `docs/observability.md`);
`npm run eval -- --live` additionally runs the real model against each
fixture and rule-checks the output.
