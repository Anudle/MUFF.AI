# League site (MUFF-71)

A small public-facing page for the league: playoff odds with a what-if picker,
a luck index, and a schedule-swap grid. It exists because the Telegram bot
needs a leaguemate to think of a question, and a page only needs them to
look. Scope is deliberately one page, read-only, current season only.

```
Tuesday digest run ──► store: site/season.json ─┐
                                                 ├─► CloudFront (origin path /site) ─► leaguemates
dist/site/{index.html,style.css,app.js} ────────┘   (uploaded by hand on deploy)
```

## Decisions

**Static page + one JSON snapshot, no API.** Everything the page shows is a
function of the season's weekly scores and the remaining schedule, and those
change once a week. So the digest run — already awake on Tuesday, already
holding provider credentials — writes one blob (`site/season.json`,
`src/site/publish.ts`) and the page fetches it. No Lambda to invoke per
visitor, nothing to rate-limit, nothing to pay for beyond CloudFront pennies.
Anything that needs a write path or a model call (pick'ems, an "Ask MUFF"
box) is out of scope for exactly that reason.

**The snapshot is built through the provider seam, not from the run
archive.** `src/site/season.ts` calls `getWeekResults(w)` for each completed
week and the new `getSchedule(from, to)` for the rest. Walking `runs/` would
have needed `s3:ListBucket` on a prefix the digest role doesn't have, and the
provider is where the archive's numbers came from anyway.

**`getSchedule` is a provider function but not an MCP tool.** It is the one
fetcher that reads weeks beyond `current_week` (pairings exist for the whole
season; scores don't, so it returns names only). The agent has no question
that needs it yet, and tool surface is not free. Fixture mode refuses it — a
transcribed week doesn't record who plays next — so the site simply isn't
refreshed while the league is in degraded mode.

**Arithmetic in code, with one exception.** All-play record, expected wins,
luck and the swap matrix are computed in `src/site/derive.ts` (pure, tested
in `test/site.test.ts`) and shipped as numbers; the browser draws them. The
exception is the playoff simulation (`src/site/sim.ts`): the what-if picker
has to re-run it on every tap, so it runs client-side. It is the same
import-free, seeded module the tests exercise — bundled, not reimplemented.

**Non-fatal, like the archive and the outbox.** `publishSite()` catches
everything and returns the key or `null`; the run reports `site_published` on
its result and in the `MUFF_RUN` line. It runs on dry runs too.

**League format lives in `src/site/config.ts`.** No provider exposes "8 teams
qualify" or "regular season ends week 14" (Yahoo's `end_week` includes the
playoffs). The constants cite `docs/league-rules.md`; change both together.

## What the numbers mean

- **All-play record** — each week, a team's result against all 13 other
  scores, summed over the season.
- **Expected wins** — the sum of weekly all-play win rates: what a team with
  those scores wins against an average schedule.
- **Luck** — actual wins (a tie is half) minus expected wins.
- **Schedule swap** — `swap[i][j]` is team *i*'s wins if it had played team
  *j*'s opponents. In the week *j* played *i*, *i* plays *j*.
- **Playoff odds** — 10,000 simulated finishes. Each remaining score is a
  normal draw around the team's season average (shrunk toward the league
  average by three games' worth, because ten games is a small sample) with
  the league's pooled week-to-week spread, rounded to whole points. A picked
  game is forced: the picked winner takes the higher of the two draws. It is
  "if everyone keeps scoring like they have", not a projection — no injuries,
  byes or lineups.

**Open assumption:** teams are ordered by wins, then points for.
`league-rules.md` defines a head-to-head tiebreak for *seeding* only and says
nothing about who qualifies on a tied record; points-for is Yahoo's default.
The page states this. If the league rules differently, change the comparator
in `sim.ts` and `derive.ts`.

## Access

An unlisted URL shared in the group, `noindex`. Anyone with the link can see
team names, managers' first names and scores; nothing else in the bucket is
reachable through the distribution (see below). No login.

## Running it

```bash
npm run site:snapshot   # build season.json into the store (data/site/ locally)
npm run site:dev        # bundle + serve on http://localhost:4173, reading the local snapshot
npm run site:bundle     # dist/site/ — the three static files to upload
```

`dist/site/` never contains `season.json`: the digest run owns that file, and
a laptop upload must not overwrite it with stale numbers.

## Hosting — to be written by Anu (IaC is hands-on)

What the code assumes; none of this exists yet.

1. **Digest role** (`infra/deploy-digest.sh` inline policy): add
   `s3:PutObject` on `arn:aws:s3:::<bucket>/site/*`. Without it the Lambda
   logs `League site snapshot failed` every Tuesday and `site_published` is
   `false`.
2. **CloudFront distribution** over the existing private bucket, using Origin
   Access Control, with **origin path `/site`** and default root object
   `index.html`. The bucket stays private; add a bucket-policy statement
   allowing `s3:GetObject` on `site/*` to the CloudFront service principal,
   conditioned on this distribution's ARN. The origin path is what keeps
   `runs/`, `outbox/` and `digest-history.json` unreachable.
3. **Caching:** `season.json` changes weekly but should show up promptly — a
   short TTL (minutes) on that path, or an invalidation after the run. The
   static files can cache longer; invalidate on upload.
4. **Upload step:** `npm run site:bundle`, then copy `dist/site/*` to
   `s3://<bucket>/site/` with the right content types (`text/html`,
   `text/css`, `text/javascript`).
5. **First publish:** `HISTORY_BUCKET=<bucket> npm run site:snapshot` from a
   laptop, so the page has data before the next Tuesday.

Things worth breaking on purpose: request `/../runs/…` and
`/digest-history.json` through the distribution (both must fail); remove the
`site/*` grant and confirm the digest still delivers.
