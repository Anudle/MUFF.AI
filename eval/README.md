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

Not to be confused with `fixtures/weekly/` (MUFF-57): those are *raw* weekly
inputs a human transcribes from Yahoo, which `deriveWeekFacts()` turns into a
`WeekFacts` blob of exactly this shape — `npm run fixture:validate <path> -- --facts out.json`
produces one, and `fixtures/weekly/2025-w01.example.json` derives byte-for-byte
into `2025-w01-blowout.json`.

**`golden/`** — real archived run records promoted to permanent test cases.
Empty until the season produces them; `npm run runs -- --pull` fetches
candidates into `data/runs/`, and the keepers get copied here — always from
S3, never from a local `npm run digest` (mock runs land in `data/runs/` too;
`facts.provenance` tells them apart).

| Golden record | Why it was promoted |
|---|---|
| `2026-w01-20260916T022817Z` | First real Yahoo week (14 teams, `source: yahoo`). Pins the curly-apostrophe team name (`Tebow’s Purity Ring`) that the model echoes as `'` — the eval must match by `teamKey()`, not bytes. |

`npm run eval` scores everything (see `docs/observability.md`);
`npm run eval -- --live` additionally runs the real model against each
fixture and rule-checks the output.
