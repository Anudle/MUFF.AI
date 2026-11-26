/**
 * MUFF-15 — Yahoo Fantasy data layer for the MCP tools.
 *
 * Two jobs:
 *  1. Hide Yahoo's ugly surface. Entities arrive as arrays of partial
 *     objects, collections are index-keyed ({"0": …, count: n}), and
 *     everything is addressed by nnn.l.nnnnn.t.n keys. None of that
 *     leaks past this file: tools take no keys at all — league and
 *     "my team" resolve server-side.
 *  2. Trim responses to what an agent actually needs. Yahoo sends ~40
 *     fields per player (headshot URLs, editorial keys…); we return the
 *     handful that matter so tool output stays token-efficient.
 */

import { yahooFetch } from "../yahoo/client.ts";
import { firstName } from "./names.ts";
import {
  resolveWeek,
  WeekNotAvailableError,
  type LeagueContext,
} from "./provider.ts";

type Json = any;

/** [{a:1},{b:2},[{c:3}]] → {a:1,b:2,c:3}. Yahoo splits one entity across many. */
function mergeFragments(node: Json): Record<string, Json> {
  if (!Array.isArray(node)) return node ?? {};
  const out: Record<string, Json> = {};
  for (const frag of node) {
    if (Array.isArray(frag)) Object.assign(out, mergeFragments(frag));
    else if (frag && typeof frag === "object") Object.assign(out, frag);
  }
  return out;
}

/** {"0":{team:…},"1":{team:…},count:2} → [mergedTeam, mergedTeam]. */
function items(collection: Json, entity: string): Record<string, Json>[] {
  if (!collection || typeof collection !== "object") return [];
  const out: Record<string, Json>[] = [];
  for (const key of Object.keys(collection)) {
    if (key === "count") continue;
    const item = collection[key]?.[entity];
    if (item !== undefined) out.push(mergeFragments(item));
  }
  return out;
}

function num(v: Json): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Yahoo nicknames are often full names; trim to a first name at the boundary (names.ts). */
function managerName(merged: Record<string, Json>): string | null {
  const managers = merged.managers;
  const nickname = Array.isArray(managers)
    ? managers[0]?.manager?.nickname
    : items(managers, "manager")[0]?.nickname;
  return firstName(typeof nickname === "string" ? nickname : null);
}

// ---------------------------------------------------------------------------
// League + team resolution (cached for the process lifetime)
// ---------------------------------------------------------------------------

let leagueCache: Promise<LeagueContext> | null = null;

/**
 * Resolve which league and team "the user" means, once per process.
 * YAHOO_LEAGUE_KEY overrides; otherwise the newest season's league wins
 * (ties broken by most teams — the real league beats side leagues).
 */
export function resolveLeague(): Promise<LeagueContext> {
  leagueCache ??= (async () => {
    let leagueKey = process.env.YAHOO_LEAGUE_KEY;
    let meta: Record<string, Json> | undefined;

    if (!leagueKey) {
      const data = (await yahooFetch(
        "users;use_login=1/games;game_codes=nfl/leagues",
      )) as Json;
      const user = mergeFragments(data.fantasy_content.users["0"].user);
      const leagues = items(user.games, "game").flatMap((game) =>
        items(game.leagues, "league"),
      );
      if (leagues.length === 0) {
        throw new Error("This Yahoo account has no NFL leagues in any season.");
      }
      leagues.sort(
        (a, b) =>
          Number(b.season) - Number(a.season) ||
          Number(b.num_teams) - Number(a.num_teams),
      );
      meta = leagues[0];
      leagueKey = meta.league_key as string;
    }

    const data = (await yahooFetch(`league/${leagueKey}/teams`)) as Json;
    const league = mergeFragments(data.fantasy_content.league);
    meta ??= league;
    const teams = items(league.teams, "team");
    const mine = teams.find((t) => Number(t.is_owned_by_current_login) === 1);
    if (!mine) {
      throw new Error(
        `Logged-in user owns no team in league ${leagueKey} (${league.name}).`,
      );
    }

    return {
      league_key: leagueKey,
      league_name: String(meta.name ?? league.name),
      season: String(meta.season ?? league.season),
      start_week: num(meta.start_week) ?? 1,
      end_week: num(meta.end_week) ?? 17,
      current_week: num(meta.current_week) ?? 1,
      is_finished: Number(meta.is_finished) === 1,
      my_team_key: mine.team_key as string,
      my_team_name: String(mine.name),
      teams: teams.map((t) => ({
        team_key: t.team_key as string,
        name: String(t.name),
        manager: managerName(t),
      })),
    };
  })();
  return leagueCache;
}

// ---------------------------------------------------------------------------
// Shaped fetchers — one per MCP tool
// ---------------------------------------------------------------------------

/** One team's week roster with per-player points. Used by getRoster (my team) and getLeagueRosters (all teams). */
async function fetchTeamRoster(teamKey: string, week: number) {
  const data = (await yahooFetch(
    `team/${teamKey}/roster;week=${week}/players/stats;type=week;week=${week}`,
  )) as Json;
  const team = mergeFragments(data.fantasy_content.team);
  const roster = team.roster?.["0"] ?? team.roster ?? {};
  return items(roster.players ?? team.roster?.["0"]?.players, "player").map((p) => ({
    name: p.name?.full ?? null,
    position: p.display_position ?? null,
    slot: mergeFragments(p.selected_position).position ?? null,
    nfl_team: p.editorial_team_abbr ?? null,
    status: p.status_full ?? p.status ?? null,
    bye_week: num(p.bye_weeks?.week),
    points: num(p.player_points?.total),
  }));
}

export async function getRoster(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    team: league.my_team_name,
    players: await fetchTeamRoster(league.my_team_key, w),
  };
}

// ---------------------------------------------------------------------------
// MUFF-72 — free-agent scout. Not an MCP tool: it compares the pool against
// "my" roster, which is private to the owner, not league information.
// ---------------------------------------------------------------------------

/** Positions the league starts (docs/league-rules.md); one Yahoo call each. */
const SCOUT_POSITIONS = ["QB", "WR", "RB", "TE", "K", "DEF"] as const;
/** Yahoo caps a players page at 25. */
const SCOUT_PAGE = 25;

function scoutRow(p: Record<string, Json>) {
  return {
    player_key: String(p.player_key),
    name: (p.name?.full ?? null) as string | null,
    position: (p.display_position ?? null) as string | null,
    nfl_team: (p.editorial_team_abbr ?? null) as string | null,
    status: (p.status_full ?? p.status ?? null) as string | null,
    bye_week: num(p.bye_weeks?.week),
    points: num(p.player_points?.total),
  };
}

/** Season-to-date league points by player key, 25 keys per call. */
async function fetchSeasonPoints(leagueKey: string, keys: string[]) {
  const out = new Map<string, number | null>();
  for (let i = 0; i < keys.length; i += SCOUT_PAGE) {
    const chunk = keys.slice(i, i + SCOUT_PAGE);
    const data = (await yahooFetch(
      `league/${leagueKey}/players;player_keys=${chunk.join(",")}/stats;type=season`,
    )) as Json;
    const league = mergeFragments(data.fantasy_content.league);
    for (const p of items(league.players, "player")) {
      out.set(String(p.player_key), num(p.player_points?.total));
    }
  }
  return out;
}

/**
 * The available-player pool for one week next to my own roster, both with
 * that week's points and season-to-date points. Availability is always "as of
 * now" — Yahoo has no historical free-agent list — so a past week shows what
 * today's free agents scored then.
 *
 * Calls run one at a time: yahooFetch has no backoff, and nothing here is
 * latency-sensitive.
 */
export async function getFreeAgents(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);

  const pool: ReturnType<typeof scoutRow>[] = [];
  for (const position of SCOUT_POSITIONS) {
    const data = (await yahooFetch(
      `league/${league.league_key}/players;status=A;position=${position}` +
        `;sort=PTS;sort_type=week;sort_week=${w};count=${SCOUT_PAGE}` +
        `/stats;type=week;week=${w}`,
    )) as Json;
    const node = mergeFragments(data.fantasy_content.league);
    for (const p of items(node.players, "player")) {
      const row = scoutRow(p);
      // A dual-position player shows up under each position; keep one row.
      if (!pool.some((r) => r.player_key === row.player_key)) pool.push(row);
    }
  }

  const rosterData = (await yahooFetch(
    `team/${league.my_team_key}/roster;week=${w}/players/stats;type=week;week=${w}`,
  )) as Json;
  const team = mergeFragments(rosterData.fantasy_content.team);
  const mine = items(team.roster?.["0"]?.players, "player").map((p) => ({
    ...scoutRow(p),
    slot: (mergeFragments(p.selected_position).position ?? null) as string | null,
  }));

  const season = await fetchSeasonPoints(
    league.league_key,
    [...pool, ...mine].map((r) => r.player_key),
  );
  const withSeason = <T extends { player_key: string }>(r: T) => ({
    ...r,
    season_points: season.get(r.player_key) ?? null,
  });

  return {
    league: league.league_name,
    season: league.season,
    week: w,
    /** True while the week can still change (it is the league's current week). */
    live: w === league.current_week && !league.is_finished,
    team: league.my_team_name,
    roster: mine.map(withSeason),
    free_agents: pool.map(withSeason),
  };
}

/**
 * Every team's roster for one week (MUFF-38 digest: bench points, start/sit).
 * One Yahoo call per team, batched 4 at a time to stay clear of rate limits.
 */
export async function getLeagueRosters(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  const teams: { team: string; manager: string | null; players: Awaited<ReturnType<typeof fetchTeamRoster>> }[] = [];
  for (let i = 0; i < league.teams.length; i += 4) {
    const batch = league.teams.slice(i, i + 4);
    const rosters = await Promise.all(batch.map((t) => fetchTeamRoster(t.team_key, w)));
    batch.forEach((t, j) =>
      teams.push({ team: t.name, manager: t.manager, players: rosters[j] }),
    );
  }
  return { league: league.league_name, season: league.season, week: w, teams };
}

function shapeMatchup(matchup: Record<string, Json>) {
  const teams = items(matchup["0"]?.teams ?? matchup.teams, "team").map((t) => ({
    team: t.name ?? null,
    manager: managerName(t),
    points: num(t.team_points?.total),
    projected_points: num(t.team_projected_points?.total),
    team_key: t.team_key as string,
  }));
  const winnerKey = matchup.winner_team_key;
  return {
    status: matchup.status ?? null,
    is_tied: Number(matchup.is_tied) === 1,
    winner: teams.find((t) => t.team_key === winnerKey)?.team ?? null,
    teams: teams.map(({ team_key, ...rest }) => rest),
  };
}

export async function getMatchup(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  const data = (await yahooFetch(
    `team/${league.my_team_key}/matchups;weeks=${w}`,
  )) as Json;
  const team = mergeFragments(data.fantasy_content.team);
  const matchup = items(team.matchups, "matchup")[0];
  if (!matchup) {
    throw new WeekNotAvailableError(w, league);
  }
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    my_team: league.my_team_name,
    ...shapeMatchup(matchup),
  };
}

export async function getStandings() {
  const league = await resolveLeague();
  const data = (await yahooFetch(`league/${league.league_key}/standings`)) as Json;
  const leagueNode = mergeFragments(data.fantasy_content.league);
  const teams = items(leagueNode.standings?.["0"]?.teams, "team").map((t) => {
    const s = t.team_standings ?? {};
    const streak = s.streak ? `${s.streak.type === "win" ? "W" : "L"}${s.streak.value}` : null;
    return {
      rank: num(s.rank),
      team: t.name ?? null,
      manager: managerName(t),
      is_my_team: t.team_key === league.my_team_key,
      wins: num(s.outcome_totals?.wins),
      losses: num(s.outcome_totals?.losses),
      ties: num(s.outcome_totals?.ties),
      points_for: num(s.points_for),
      points_against: num(s.points_against),
      streak,
    };
  });
  teams.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return {
    league: league.league_name,
    season: league.season,
    standings: teams,
  };
}

export async function getTransactions(count = 10) {
  const league = await resolveLeague();
  const data = (await yahooFetch(
    `league/${league.league_key}/transactions;count=${count}`,
  )) as Json;
  const leagueNode = mergeFragments(data.fantasy_content.league);
  const transactions = items(leagueNode.transactions, "transaction").map((t) => ({
    type: t.type ?? null,
    status: t.status ?? null,
    date: t.timestamp
      ? new Date(Number(t.timestamp) * 1000).toISOString().slice(0, 10)
      : null,
    players: items(t.players, "player").map((p) => {
      const td = mergeFragments(p.transaction_data);
      return {
        name: p.name?.full ?? null,
        position: p.display_position ?? null,
        action: td.type ?? null,
        from: td.source_team_name ?? td.source_type ?? null,
        to: td.destination_team_name ?? td.destination_type ?? null,
      };
    }),
  }));
  return {
    league: league.league_name,
    season: league.season,
    transactions,
  };
}

/**
 * MUFF-71 — who plays whom in weeks fromWeek..toWeek, INCLUDING weeks not yet
 * played (the league site's playoff what-if needs the remaining slate). The
 * one fetcher that deliberately skips resolveWeek's upper bound: pairings
 * exist for the whole season, scores don't, so this returns names only.
 * Not an MCP tool.
 */
export async function getSchedule(fromWeek: number, toWeek: number) {
  const league = await resolveLeague();
  if (fromWeek < league.start_week || toWeek > league.end_week) {
    throw new Error(
      `Schedule weeks ${fromWeek}–${toWeek} are outside the season (${league.start_week}–${league.end_week}). Do not retry.`,
    );
  }
  const weeks: number[] = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  return Promise.all(
    weeks.map(async (w) => {
      const data = (await yahooFetch(
        `league/${league.league_key}/scoreboard;week=${w}`,
      )) as Json;
      const leagueNode = mergeFragments(data.fantasy_content.league);
      const matchups = items(
        leagueNode.scoreboard?.["0"]?.matchups ?? leagueNode.scoreboard?.matchups,
        "matchup",
      ).map((m) => shapeMatchup(m).teams.map((t) => String(t.team)));
      return { week: w, matchups };
    }),
  );
}

export async function getWeekResults(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  const data = (await yahooFetch(
    `league/${league.league_key}/scoreboard;week=${w}`,
  )) as Json;
  const leagueNode = mergeFragments(data.fantasy_content.league);
  const matchups = items(
    leagueNode.scoreboard?.["0"]?.matchups ?? leagueNode.scoreboard?.matchups,
    "matchup",
  ).map(shapeMatchup);
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    matchups,
  };
}
