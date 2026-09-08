/**
 * MUFF-57 — the manual ingestion contract (MUFF-50 degraded mode).
 *
 * While the Yahoo API is blocked, a human reads the league page on Tuesday
 * morning and transcribes ONE file per week into fixtures/weekly/. This
 * module is that file's contract: what the human must type, what they may
 * leave out, and what the validator will refuse.
 *
 * The design decision worth defending (CCA-F: tool/data contract design):
 * the fixture holds RAW inputs — matchup scores, standings rows, transaction
 * lines — never derived numbers. Margins, superlatives, projection deltas
 * and bench blunders are computed by deriveWeekFacts() exactly as they are
 * on the API path. Two reasons:
 *
 *   1. Grounding. "Every number the model cites was computed in code" is the
 *      digest's core invariant (docs/digest-design.md). A hand-typed
 *      `closest_game.margin` would be the first number in the pipeline that
 *      nothing checks.
 *   2. Error detection. Raw inputs are redundant with each other — a team's
 *      points_for grows by exactly this week's score, wins+losses equals the
 *      week number, the winner's streak starts with W. A transcription slip
 *      in one cell contradicts another cell, and checkWeeklyFixture() sees
 *      it. Derived fields typed by hand have no such witness.
 *
 * What v1 cut (docs/ingestion-checklist.md has the reasoning): full rosters
 * (~150 cells for 12 teams — the whole 10-minute budget), points_against,
 * transaction status. Bench totals and one notable start/sit per team are
 * OPTIONAL — the derive still computes the delta and would-it-have-flipped.
 */

import { z } from "zod";
import { deriveWeekFacts, type WeekFacts, type WeekInputs } from "../digest/facts.ts";

export const FIXTURE_SCHEMA_VERSION = 1;

const name = z.string().trim().min(1);
const points = z.number().finite().min(0);
const count = z.number().int().min(0);

const MatchupTeam = z.strictObject({
  team: name,
  points,
  /** Yahoo's pre-game projection. Null when the scoreboard no longer shows it. */
  projected: points.nullable().default(null),
});

const StandingRow = z.strictObject({
  rank: z.number().int().min(1),
  team: name,
  /** Manager first name, for the digest's personal touch. Optional. */
  manager: name.nullable().default(null),
  wins: count,
  losses: count,
  ties: count.default(0),
  points_for: points,
  /** Yahoo's streak column, e.g. "W3" / "L1". */
  streak: z.string().regex(/^[WLT]\d+$/, 'expected "W3" / "L1" style').nullable().default(null),
});

const TransactionPlayer = z.strictObject({
  name,
  position: name,
  action: z.enum(["add", "drop", "trade"]),
  /** Team name, "FA" (free agents) or "W" (waivers). */
  from: name.nullable().default(null),
  to: name.nullable().default(null),
});

const Transaction = z.strictObject({
  type: z.enum(["add", "drop", "add/drop", "trade", "commish"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  players: z.array(TransactionPlayer).min(1),
});

const BenchTotal = z.strictObject({ team: name, bench_points: points });

/**
 * One start/sit blunder the human noticed on the matchup page: a benched
 * player who outscored a starter he could legally have replaced. The delta
 * and the would-have-flipped verdict are derived, not typed.
 */
const StartSit = z.strictObject({
  team: name,
  benched: z.strictObject({ name, position: name, points }),
  started: z.strictObject({ name, slot: name, points }),
});

export const WeeklyFixtureSchema = z.strictObject({
  schema_version: z.literal(FIXTURE_SCHEMA_VERSION),
  /** Provenance (MUFF-58 reads this to tell degraded-mode data from API data). */
  source: z.strictObject({
    kind: z.literal("manual"),
    ingested_by: name,
    /** Stamped by the upload step; leave null when transcribing. */
    ingested_at: z.iso.datetime().nullable().default(null),
    notes: z.string().default(""),
  }),
  league: name,
  season: z.string().regex(/^\d{4}$/, "expected a 4-digit season"),
  week: z.number().int().min(1).max(18),
  matchups: z.array(z.strictObject({ teams: z.tuple([MatchupTeam, MatchupTeam]) })).min(1),
  standings: z.array(StandingRow).min(2),
  transactions: z.array(Transaction).default([]),
  bench_points: z.array(BenchTotal).default([]),
  start_sit: z.array(StartSit).default([]),
});

export type WeeklyFixture = z.infer<typeof WeeklyFixtureSchema>;

export interface FixtureIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

/**
 * Drop every key that starts with "_" (the template's `_source` / `_readme`
 * hints) so the strict schema sees only data. Hints may be left in a filled
 * fixture — they cost nothing and keep the source of each field next to it.
 */
export function stripHints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHints);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k, stripHints(v)]),
    );
  }
  return value;
}

/** Schema pass. Returns the parsed fixture or one issue per problem, path-addressed. */
export function parseWeeklyFixture(
  raw: unknown,
): { fixture: WeeklyFixture; issues: [] } | { fixture: null; issues: FixtureIssue[] } {
  const result = WeeklyFixtureSchema.safeParse(stripHints(raw));
  if (result.success) return { fixture: result.data, issues: [] };
  return {
    fixture: null,
    issues: result.error.issues.map((i) => ({
      level: "error",
      path: i.path.length ? i.path.map(String).join(".") : "(root)",
      message: i.message,
    })),
  };
}

const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;
const r2 = (n: number) => +n.toFixed(2);

/**
 * Cross-field checks: the redundancy between scores, records, streaks and
 * season totals is what catches a transcription slip. Errors block the
 * fixture; warnings print and pass. Pass last week's fixture as `prev` for
 * the strongest checks (every record and points_for delta is then verified).
 */
export function checkWeeklyFixture(f: WeeklyFixture, prev?: WeeklyFixture | null): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  const error = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });

  // --- standings shape --------------------------------------------------------
  const teams = new Set<string>();
  f.standings.forEach((s, i) => {
    if (teams.has(s.team)) error(`standings.${i}.team`, `"${s.team}" appears twice in standings`);
    teams.add(s.team);
  });
  const ranks = f.standings.map((s) => s.rank).sort((a, b) => a - b);
  if (!ranks.every((r, i) => r === i + 1)) {
    error("standings", `ranks must be exactly 1..${f.standings.length} with no gaps or repeats (got ${ranks.join(",")})`);
  }
  const totalWins = f.standings.reduce((n, s) => n + s.wins, 0);
  const totalLosses = f.standings.reduce((n, s) => n + s.losses, 0);
  if (totalWins !== totalLosses) {
    error("standings", `league-wide wins (${totalWins}) must equal losses (${totalLosses}) — a W-L column is mistyped`);
  }
  f.standings.forEach((s, i) => {
    const played = s.wins + s.losses + s.ties;
    if (played !== f.week) {
      error(`standings.${i}`, `"${s.team}" has ${played} games in its record but this is week ${f.week}`);
    }
  });

  // --- matchups vs standings --------------------------------------------------
  const seen = new Map<string, number>();
  const noProjection: string[] = [];
  const thisWeek = new Map<string, { points: number; won: boolean | null }>();
  f.matchups.forEach((m, i) => {
    const [a, b] = m.teams;
    if (a.team === b.team) error(`matchups.${i}`, `"${a.team}" is listed against itself`);
    m.teams.forEach((t, j) => {
      const path = `matchups.${i}.teams.${j}`;
      if (!teams.has(t.team)) error(`${path}.team`, `"${t.team}" is not in standings — typo, or missing standings row?`);
      if (seen.has(t.team)) error(`${path}.team`, `"${t.team}" already played in matchup ${seen.get(t.team)}`);
      seen.set(t.team, i);
      if (!near(t.points, r2(t.points), 1e-9)) warn(`${path}.points`, `Yahoo shows 2 decimals; ${t.points} looks mistyped`);
      if (t.projected === null) noProjection.push(t.team);
      const won = a.points === b.points ? null : t.points > (j === 0 ? b.points : a.points);
      thisWeek.set(t.team, { points: t.points, won });
    });
  });
  for (const t of teams) {
    if (!seen.has(t)) warn("matchups", `"${t}" has no matchup this week (bye?) — its standings row can't be cross-checked`);
  }
  if (noProjection.length === seen.size) {
    if (noProjection.length) warn("matchups", "no projections this week — over/underachiever facts will be omitted");
  } else {
    for (const t of noProjection) warn("matchups", `no projection for "${t}" — it can't be the over/underachiever`);
  }

  // --- per-team consistency: this week's result vs the standings row ----------
  f.standings.forEach((s, i) => {
    const g = thisWeek.get(s.team);
    if (!g) return;
    if (s.points_for + 0.011 < g.points) {
      error(`standings.${i}.points_for`, `"${s.team}" season points_for (${s.points_for}) is below this week's score (${g.points})`);
    }
    if (f.week === 1 && !near(s.points_for, g.points)) {
      error(`standings.${i}.points_for`, `week 1: "${s.team}" points_for (${s.points_for}) must equal its score (${g.points})`);
    }
    if (s.streak && g.won !== null) {
      const expect = g.won ? "W" : "L";
      if (!s.streak.startsWith(expect)) {
        error(`standings.${i}.streak`, `"${s.team}" ${g.won ? "won" : "lost"} this week, so streak must start with ${expect} (got ${s.streak})`);
      }
    }
    if (f.week === 1) {
      const want = g.won === null ? 0 : g.won ? 1 : 0;
      if (s.wins !== want) error(`standings.${i}.wins`, `week 1: "${s.team}" ${g.won ? "won" : "did not win"} but wins is ${s.wins}`);
    }
  });

  // --- optional roster extras -------------------------------------------------
  const benchTeams = new Set<string>();
  f.bench_points.forEach((b, i) => {
    if (!teams.has(b.team)) error(`bench_points.${i}.team`, `"${b.team}" is not in standings`);
    if (benchTeams.has(b.team)) error(`bench_points.${i}.team`, `"${b.team}" listed twice`);
    benchTeams.add(b.team);
  });
  if (benchTeams.size > 0 && benchTeams.size < teams.size) {
    warn("bench_points", `bench totals for ${benchTeams.size}/${teams.size} teams — the digest's bench ranking will only cover those`);
  }
  f.start_sit.forEach((s, i) => {
    if (!teams.has(s.team)) error(`start_sit.${i}.team`, `"${s.team}" is not in standings`);
    if (s.benched.points <= s.started.points) {
      warn(`start_sit.${i}`, `"${s.team}": benched ${s.benched.name} (${s.benched.points}) did not outscore ${s.started.name} (${s.started.points}) — not a blunder, will be ignored`);
    }
    const total = f.bench_points.find((b) => b.team === s.team);
    if (total && total.bench_points + 0.011 < s.benched.points) {
      error(`start_sit.${i}.benched.points`, `"${s.team}": benched player has ${s.benched.points} but the team's bench total is ${total.bench_points}`);
    }
  });

  // --- transactions -----------------------------------------------------------
  if (f.transactions.length > 10) warn("transactions", `${f.transactions.length} listed; the digest uses the first 10`);
  const today = new Date().toISOString().slice(0, 10);
  f.transactions.forEach((t, i) => {
    if (t.date > today) warn(`transactions.${i}.date`, `${t.date} is in the future`);
  });

  // --- last week's fixture: the strongest witness -----------------------------
  if (prev) {
    if (prev.season !== f.season) error("season", `previous fixture is season ${prev.season}, this one is ${f.season}`);
    if (prev.week !== f.week - 1) error("week", `previous fixture is week ${prev.week}; expected week ${f.week - 1}`);
    else {
      const prevBy = new Map(prev.standings.map((s) => [s.team, s]));
      f.standings.forEach((s, i) => {
        const p = prevBy.get(s.team);
        const g = thisWeek.get(s.team);
        if (!p) {
          warn(`standings.${i}.team`, `"${s.team}" was not in last week's standings — renamed team?`);
          return;
        }
        const dw = g ? (g.won === true ? 1 : 0) : 0;
        const dl = g ? (g.won === false ? 1 : 0) : 0;
        const dt = g ? (g.won === null ? 1 : 0) : 0;
        if (s.wins !== p.wins + dw) error(`standings.${i}.wins`, `"${s.team}" had ${p.wins} wins last week ${dw ? "and won" : "and did not win"}; expected ${p.wins + dw}, got ${s.wins}`);
        if (s.losses !== p.losses + dl) error(`standings.${i}.losses`, `"${s.team}" had ${p.losses} losses last week ${dl ? "and lost" : "and did not lose"}; expected ${p.losses + dl}, got ${s.losses}`);
        if (s.ties !== p.ties + dt) error(`standings.${i}.ties`, `"${s.team}" ties: expected ${p.ties + dt}, got ${s.ties}`);
        if (g && !near(s.points_for, p.points_for + g.points)) {
          error(`standings.${i}.points_for`, `"${s.team}" points_for should be ${r2(p.points_for)} + ${g.points} = ${r2(p.points_for + g.points)}, got ${s.points_for}`);
        }
      });
    }
  }

  return issues;
}

/**
 * Shape the fixture as the four provider payloads deriveWeekFacts() expects,
 * so the manual path and the API path share every line of derivation.
 * Optional bench totals / start-sit entries become a minimal synthetic
 * roster: one "rest of bench" BN line plus the named pair, which is exactly
 * enough for facts.ts to compute bench_points and worst_start_sit itself.
 */
export function toWeekInputs(
  f: WeeklyFixture,
  previousPowerRankings: WeekFacts["previous_power_rankings"] = null,
): WeekInputs {
  const managerOf = new Map(f.standings.map((s) => [s.team, s.manager]));
  const manager = (team: string) => managerOf.get(team) ?? null;

  const matchups = f.matchups.map((m) => {
    const [a, b] = m.teams;
    const is_tied = a.points === b.points;
    return {
      status: "postevent" as string | null,
      is_tied,
      winner: is_tied ? null : a.points > b.points ? a.team : b.team,
      teams: m.teams.map((t) => ({
        team: t.team as string | null,
        manager: manager(t.team),
        points: t.points as number | null,
        projected_points: t.projected,
      })),
    };
  });

  type Player = WeekInputs["rosters"]["teams"][number]["players"][number];
  const blank = { nfl_team: null, status: null, bye_week: null };
  const rosterTeams = new Map<string, Player[]>();
  const roster = (team: string) => {
    if (!rosterTeams.has(team)) rosterTeams.set(team, []);
    return rosterTeams.get(team)!;
  };
  for (const s of f.start_sit) {
    roster(s.team).push(
      { ...blank, name: s.benched.name, position: s.benched.position, slot: "BN", points: s.benched.points },
      { ...blank, name: s.started.name, position: null, slot: s.started.slot, points: s.started.points },
    );
  }
  for (const b of f.bench_points) {
    const named = f.start_sit.filter((s) => s.team === b.team).reduce((n, s) => n + s.benched.points, 0);
    roster(b.team).push({ ...blank, name: "Rest of bench", position: null, slot: "BN", points: r2(b.bench_points - named) });
  }

  return {
    results: { league: f.league, season: f.season, week: f.week, matchups },
    standings: {
      league: f.league,
      season: f.season,
      standings: f.standings.map((s) => ({
        rank: s.rank as number | null,
        team: s.team as string | null,
        manager: s.manager,
        is_my_team: false,
        wins: s.wins as number | null,
        losses: s.losses as number | null,
        ties: s.ties as number | null,
        points_for: s.points_for as number | null,
        points_against: null,
        streak: s.streak,
      })),
    },
    transactions: {
      league: f.league,
      season: f.season,
      transactions: f.transactions.map((t) => ({
        type: t.type as string | null,
        status: "successful" as string | null,
        date: t.date as string | null,
        players: t.players.map((p) => ({
          name: p.name as string | null,
          position: p.position as string | null,
          action: p.action as string | null,
          from: p.from,
          to: p.to,
        })),
      })),
    },
    rosters: {
      league: f.league,
      season: f.season,
      week: f.week,
      teams: [...rosterTeams].map(([team, players]) => ({ team, manager: manager(team), players })),
    },
    previous_power_rankings: previousPowerRankings,
  };
}

/** The whole manual path in one call: fixture → provider shapes → WeekFacts. */
export function fixtureToFacts(
  f: WeeklyFixture,
  previousPowerRankings: WeekFacts["previous_power_rankings"] = null,
): WeekFacts {
  return deriveWeekFacts(f.week, toWeekInputs(f, previousPowerRankings));
}
