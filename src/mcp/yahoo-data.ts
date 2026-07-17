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

function managerName(merged: Record<string, Json>): string | null {
  const managers = merged.managers;
  if (Array.isArray(managers)) return managers[0]?.manager?.nickname ?? null;
  return items(managers, "manager")[0]?.nickname ?? null;
}

// ---------------------------------------------------------------------------
// League + team resolution (cached for the process lifetime)
// ---------------------------------------------------------------------------

export interface LeagueContext {
  league_key: string;
  league_name: string;
  season: string;
  start_week: number;
  end_week: number;
  current_week: number;
  is_finished: boolean;
  my_team_key: string;
  my_team_name: string;
}

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
    };
  })();
  return leagueCache;
}

/** Thrown for weeks outside the played range; mapped to WEEK_NOT_AVAILABLE. */
export class WeekNotAvailableError extends Error {
  constructor(week: number, league: LeagueContext) {
    super(
      `Week ${week} is not available for ${league.league_name} (season ${league.season}): ` +
        `valid weeks are ${league.start_week}–${league.current_week}. ` +
        `Do not retry with this week; omit the week argument to use the current week.`,
    );
    this.name = "WeekNotAvailableError";
  }
}

function resolveWeek(league: LeagueContext, week?: number): number {
  if (week === undefined) return league.current_week;
  if (week < league.start_week || week > league.current_week) {
    throw new WeekNotAvailableError(week, league);
  }
  return week;
}

// ---------------------------------------------------------------------------
// Shaped fetchers — one per MCP tool
// ---------------------------------------------------------------------------

export async function getRoster(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  const data = (await yahooFetch(
    `team/${league.my_team_key}/roster;week=${w}/players/stats;type=week;week=${w}`,
  )) as Json;
  const team = mergeFragments(data.fantasy_content.team);
  const roster = team.roster?.["0"] ?? team.roster ?? {};
  const players = items(roster.players ?? team.roster?.["0"]?.players, "player").map(
    (p) => ({
      name: p.name?.full ?? null,
      position: p.display_position ?? null,
      slot: mergeFragments(p.selected_position).position ?? null,
      nfl_team: p.editorial_team_abbr ?? null,
      status: p.status_full ?? p.status ?? null,
      bye_week: num(p.bye_weeks?.week),
      points: num(p.player_points?.total),
    }),
  );
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    team: league.my_team_name,
    players,
  };
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
