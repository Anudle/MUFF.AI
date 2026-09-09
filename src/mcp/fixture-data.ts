/**
 * MUFF-58 — the manual-ingestion provider (MUFF-50 degraded mode).
 *
 * FANTASY_PROVIDER=fixture serves the provider contract from hand-transcribed
 * weekly fixtures (contract: src/ingest/weekly-fixture.ts) that
 * `npm run fixture:upload` has dropped into the blob store under
 *
 *   fixtures/weekly/<season>-wNN.json      (data/ locally, HISTORY_BUCKET on Lambda)
 *
 * — the same layout as the repo's fixtures/weekly/, so a key is derivable
 * from (season, week) and nothing needs a "latest" pointer: the newest key
 * in a sorted listing IS the latest week (zero-padded weeks make sort()
 * chronological, the same trick the run archive uses).
 *
 * Why a provider and not a branch in facts.ts: the digest, the MCP tools and
 * the evals must stay provider-blind (CLAUDE.md). A human-in-the-loop data
 * source is a source like any other — it gets the same seam, the same
 * contract, and the compiler proves it implements it (data.ts types this
 * module as `typeof yahoo`). Manual mode is a value, not a fallthrough.
 *
 * "Current week" semantics mirror Yahoo's on a Tuesday morning: the latest
 * fixture is the last COMPLETED week, so current_week = latest + 1 and
 * gatherWeekFacts()'s `current_week - 1` lands on it.
 */

import { store, storeLabel } from "../store.ts";
import {
  fixtureKey,
  FIXTURES_PREFIX,
  parseFixtureKey,
  parseWeeklyFixture,
  toWeekInputs,
  type WeeklyFixture,
} from "../ingest/weekly-fixture.ts";
import { WeekNotAvailableError, type LeagueContext, type Provenance } from "./provider.ts";

interface FixtureIndex {
  season: string;
  weeks: number[];
}

let indexCache: Promise<FixtureIndex> | null = null;
let leagueCache: Promise<LeagueContext> | null = null;
const fixtureCache = new Map<number, Promise<WeeklyFixture>>();

/**
 * Which season and weeks the store holds. FIXTURE_SEASON pins a season;
 * otherwise the newest season present wins (same rule as Yahoo's
 * resolveLeague: the newest season is "the" league).
 */
function loadIndex(): Promise<FixtureIndex> {
  indexCache ??= (async () => {
    const keys = await store.list(FIXTURES_PREFIX);
    const parsed = keys.map(parseFixtureKey).filter((k): k is NonNullable<typeof k> => k !== null);
    const season =
      process.env.FIXTURE_SEASON ??
      parsed.map((k) => k.season).sort().at(-1);
    const weeks = parsed
      .filter((k) => k.season === season)
      .map((k) => k.week)
      .sort((a, b) => a - b);
    if (!season || weeks.length === 0) {
      throw new Error(
        `No weekly fixtures under ${storeLabel}${FIXTURES_PREFIX}/` +
          (process.env.FIXTURE_SEASON ? ` for season ${process.env.FIXTURE_SEASON}` : "") +
          ". Upload one with `npm run fixture:upload <fixture.json>` (FANTASY_PROVIDER=fixture reads only the store). Do not retry until a fixture exists.",
      );
    }
    return { season, weeks };
  })();
  return indexCache;
}

function loadFixture(week: number): Promise<WeeklyFixture> {
  let cached = fixtureCache.get(week);
  if (!cached) {
    cached = (async () => {
      const { season, weeks } = await loadIndex();
      const key = fixtureKey(season, week);
      const raw = weeks.includes(week) ? await store.read<unknown>(key) : null;
      if (raw === null) {
        // Phrase the range as fixtures actually present, not current_week
        // (which is latest+1 and has no fixture yet).
        const league = await resolveLeague();
        throw new WeekNotAvailableError(week, { ...league, current_week: weeks.at(-1)! });
      }
      const parsed = parseWeeklyFixture(raw);
      if (!parsed.fixture) {
        const detail = parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
        throw new Error(
          `Fixture ${storeLabel}${key} does not validate (${detail}). ` +
            "It was uploaded without `npm run fixture:upload` or the contract changed; re-upload it. Do not retry.",
        );
      }
      return parsed.fixture;
    })();
    fixtureCache.set(week, cached);
  }
  return cached;
}

export function resolveLeague(): Promise<LeagueContext> {
  leagueCache ??= (async () => {
    const { season, weeks } = await loadIndex();
    const latest = await loadFixture(weeks.at(-1)!);
    return {
      league_key: `fixture:${season}`,
      league_name: latest.league,
      season,
      start_week: weeks[0],
      end_week: 18,
      current_week: weeks.at(-1)! + 1,
      is_finished: false,
      // A transcribed league has no "logged-in user"; my-team tools refuse.
      my_team_key: "",
      my_team_name: "",
      teams: latest.standings.map((s) => ({
        team_key: `fixture:${season}:${s.rank}`,
        name: s.team,
        manager: s.manager,
      })),
    };
  })();
  return leagueCache;
}

async function weekOrLatest(week?: number): Promise<number> {
  if (week !== undefined) return week;
  const { weeks } = await loadIndex();
  return weeks.at(-1)!;
}

function unavailable(tool: string): never {
  throw new Error(
    `${tool} is not available in fixture mode (FANTASY_PROVIDER=fixture): weekly fixtures hold ` +
      "no full rosters and no \"my team\". Do not retry; use get_standings or get_week_results instead.",
  );
}

export async function getRoster(_week?: number) {
  return unavailable("get_roster");
}

export async function getMatchup(_week?: number) {
  return unavailable("get_matchup");
}

export async function getLeagueRosters(week?: number) {
  const f = await loadFixture(await weekOrLatest(week));
  return toWeekInputs(f).rosters;
}

export async function getStandings() {
  const f = await loadFixture(await weekOrLatest());
  return toWeekInputs(f).standings;
}

export async function getTransactions(count = 10) {
  const f = await loadFixture(await weekOrLatest());
  const tx = toWeekInputs(f).transactions;
  return { ...tx, transactions: tx.transactions.slice(0, count) };
}

export async function getWeekResults(week?: number) {
  const f = await loadFixture(await weekOrLatest(week));
  return toWeekInputs(f).results;
}

/** The fixture's own provenance block — who typed this week, and when it was uploaded. */
export async function getProvenance(week: number): Promise<Provenance> {
  const f = await loadFixture(week);
  return { source: f.source.kind, ingested_by: f.source.ingested_by, ingested_at: f.source.ingested_at };
}
