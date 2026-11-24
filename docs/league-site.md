# League site (MUFF-71)

A small public-facing page for the league: the week's recap and power
rankings, playoff odds with a what-if picker, the playoff bracket those picks
produce, a luck index, and a ranking of each team's remaining schedule. It exists because the Telegram bot
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
luck and the run-in are computed in `src/site/derive.ts` (pure, tested
in `test/site.test.ts`) and shipped as numbers; the browser draws them. The
exception is the playoff simulation (`src/site/sim.ts`): the what-if picker
has to re-run it on every tap, so it runs client-side. It is the same
import-free, seeded module the tests exercise — bundled, not reimplemented.

**The recap and power rankings are the delivered digest, not a second
generation.** A delivering run passes its digest to `publishSite()`, which
stores it in the snapshot as `digest` (`toSiteDigest` in `derive.ts` adds each
team's previous rank, so the page's arrows are computed in code like the chat
message's). A dry run and `npm run site:snapshot` pass nothing and carry
forward the `digest` already in `site/season.json`, so the site only ever
shows what the chat saw. It is carried from the snapshot's own key rather
than read from the run archive for the same reason as above: the digest role
can get `site/*` but cannot list `runs/`. No model call is made for the site.

**The bracket is deterministic; only the odds are simulated.** "Playoff
picture" is today's standings plus the picked winners (`seedings()` in
`sim.ts`): unpicked games are left out and the page says how many, and a
picked game adds a win and a loss but no points. So
the odds bars (which simulate scores for every remaining game) and the
bracket can disagree about a bubble team; they answer different questions.
Pairings are 1v8, 4v5, 2v7, 3v6 in week 15 with no reseeding, per
`league-rules.md`; the 1/8 and 4/5 winners meet in week 16, as do the 2/7
and 3/6 winners (Anu confirmed the bracket shape on 2026-11-23).

**Non-fatal, like the archive and the outbox.** `publishSite()` catches
everything and returns the key or `null`; the run reports `site_published` on
its result and in the `MUFF_RUN` line. It runs on dry runs too.

**League format lives in `src/site/config.ts`.** No provider exposes "8 teams
qualify" or "regular season ends week 14" (Yahoo's `end_week` includes the
playoffs). The constants cite `docs/league-rules.md`; change both together.

**One theme, dark.** The page does not follow the device's light/dark
setting: black and gold (Monarch's colours) is the league's look, and one
theme is half the surface to check. The MUFF wordmark is drawn as inline SVG
in `web/index.html`, a varsity block letterform in those colours, rather
than loading the school's logo file into a public repo. Gold is identity
only; data stays blue (red for the unfavourable side) so the two never
compete.

## What the numbers mean

- **All-play record** — each week, a team's result against all 13 other
  scores, summed over the season.
- **Expected wins** — the sum of weekly all-play win rates: what a team with
  those scores wins against an average schedule.
- **Luck** — actual wins (a tie is half) minus expected wins.
- **The road ahead** — `road.opp_avg` is the average season points per game
  of a team's remaining opponents (one entry per game left, so an opponent
  faced twice counts twice); `road.vs_league` is that minus the league's
  average points per game. Negative is an easier run-in. It is null once no
  games remain, and the page hides the section for a snapshot without it.
- **Playoff odds** — 10,000 simulated finishes. Each remaining score is a
  normal draw around the team's season average (shrunk toward the league
  average by three games' worth, because ten games is a small sample) with
  the league's pooled week-to-week spread, rounded to whole points. A picked
  game is forced: the picked winner takes the higher of the two draws. It is
  "if everyone keeps scoring like they have", not a projection — no injuries,
  byes or lineups.

**Standing order:** wins (a tie is half), then points for — the order of
Yahoo's standings page for this league. One comparator, `rankTeams()` in
`sim.ts`, orders the snapshot (`derive.ts`), every simulated finish and the
bracket. A head-to-head tiebreak (the wording in `league-rules.md`) was
shipped briefly on 2026-11-23 and removed the same day: it put O-moss-em
above The Baker Mayfields among the 5-5 teams, and Yahoo's standings did
not. If Yahoo's final seeding ever differs from its standings order, this
comparator is the one place to change.

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

## Hosting

Written and deployed by Anu (IaC is hands-on) on 2026-11-18, by hand with the
AWS CLI. The site URL is deliberately **not in this repo**: the repo is public
and the link is unlisted, so the `*.cloudfront.net` address lives with the
league, not here. Find it with `aws cloudfront list-distributions`.

```
leaguemate ──HTTPS──► CloudFront distribution ──signed (OAC)──► private S3 bucket
                      origin path /site                         site/index.html, style.css, app.js
                                                                site/season.json  ◄── digest Lambda (Tuesdays)
```

### What exists

| Piece | Where it is defined | What it does |
|---|---|---|
| Digest role grant | `infra/deploy-digest.sh` inline policy | `s3:GetObject` + `s3:PutObject` on `site/*`, so `publishSite()` can write the snapshot and, on a run that isn't delivering, read the current one to carry its `digest` forward. It shares the statement with `runs/*` and `players/*` for simplicity. |
| Origin Access Control `muff-site-oac` | created once with `aws cloudfront create-origin-access-control` | Origin type `s3`, `sigv4`, signing behavior `always`: CloudFront signs every request to the bucket. |
| Distribution | `infra/site-distribution.json` | Origin is the bucket's **regional** endpoint (`<bucket>.s3.us-east-2.amazonaws.com`), origin path `/site`, default root object `index.html`, `PriceClass_100`. |
| Bucket policy | `infra/site-bucket-policy.json` | One statement: the CloudFront service principal may `s3:GetObject` on `site/*`, conditioned on this distribution's ARN. |

The bucket's public access block stays fully on. The bucket is still private;
the distribution is the only way in, and only to `site/`.

### Decisions

- **Origin path `/site` is the isolation.** CloudFront prefixes every request
  with it, so `/digest-history.json` asks S3 for `site/digest-history.json`.
  No URL reaches `runs/`, `outbox/` or `digest-history.json`.
- **The `Condition` on the bucket policy is not optional.** Without
  `AWS:SourceArn`, any CloudFront distribution in any account could read
  `site/*`.
- **No `s3:ListBucket`.** A missing file therefore returns 403, not 404, so
  the site cannot be used to probe which keys exist.
- **Caching is off** (AWS managed policy `CachingDisabled`). Every request
  goes to S3, so a new snapshot or a re-uploaded page shows up immediately and
  nothing needs invalidating. With a 14-person league the request cost is
  nothing. The trade-off: no edge caching and no CloudFront compression. If
  that ever matters, switch the default behavior to `CachingOptimized` and
  invalidate on upload and after the digest run.
- **`https-only`.** A plain `http://` request gets 403. The shared link is
  `https://`, so this works; `redirect-to-https` would be friendlier to
  someone typing the address by hand.

### Updating the page

```bash
npm run site:bundle
aws s3 sync dist/site/ s3://<bucket>/site/
```

`site:bundle` stamps the `app.js` and `style.css` URLs in the copied
`index.html` with a content hash (`app.js?v=…`). The bucket sets no
`Cache-Control`, so without it a returning browser pairs the new page with
its cached old script and draws empty sections (seen on 2026-11-23, when the
bracket shipped). The distribution forwards no query strings, so S3 is still
asked for plain `app.js`.

**Never add `--delete`.** `season.json` is written by the digest run and is
never in `dist/site/`, so `--delete` would remove it on every upload. The CLI
sets content types from the file extensions (`text/html`, `text/css`,
`text/javascript`); the store writes `season.json` as `application/json`.

To refresh the numbers without waiting for Tuesday:

```bash
HISTORY_BUCKET=<bucket> npm run site:snapshot
```

That write uses the laptop's AWS credentials, not the Lambda role.

### Verified by breaking it (2026-11-18)

| Attempt | Result | Stopped by |
|---|---|---|
| `/digest-history.json` through the distribution | 403 | origin path |
| `/../runs/` through the distribution | 400 | CloudFront rejects the path before S3 sees it |
| `site/index.html` straight from the S3 endpoint | 403 | bucket policy (`Principal` + `Condition`) and the public access block |

### Not done yet

- **The Lambda's own write is unproven.** The first snapshot was written from
  a laptop. The first digest run after the deploy is the real test of the
  `site/*` grant: look for `site_published: true` on the `MUFF_RUN` line.
- **Removing the `site/*` grant** and confirming the digest still delivers
  (the non-fatal path) has not been tried against AWS; `test/site.test.ts`
  covers it in code only.
- **No `infra/deploy-site.sh`.** The OAC, distribution and bucket policy were
  created by one-off commands, so unlike the other `infra/` scripts this is
  not yet idempotent or rebuildable from one command.
