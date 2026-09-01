/**
 * MUFF-49 — Sleeper Fantasy data layer: the same seven exports as
 * yahoo-data.ts, shaped to the same contracts, selected via
 * FANTASY_PROVIDER=sleeper (see data.ts). Nothing above this layer —
 * tools, digest facts, evals — knows which provider it's on.
 *
 * Sleeper quirks hidden here (full mapping: docs/sleeper-spike.md):
 *  - Everything speaks player IDs; names resolve via the cached trimmed
 *    players map (src/sleeper/players.ts).
 *  - No standings endpoint: derived from roster season settings, where
 *    points are split integer/decimal (fpts + fpts_decimal/100).
 *  - No winner field on matchups: pair entries by matchup_id, compare points.
 *  - No projected points in the documented API: projected_points is null,
 *    and the digest's over/underachiever facts degrade to null with it.
 *  - Transactions are per-week; failed waiver claims are filtered out.
 *  - Lineup slots are translated to Yahoo's vocabulary (FLEX → "W/R/T")
 *    so facts.ts start/sit eligibility logic applies unchanged.
 */

import { sleeperFetch } from "../sleeper/client.ts";
import { loadPlayers } from "../sleeper/players.ts";
import {
  resolveWeek,
  WeekNotAvailableError,
  type LeagueContext,
} from "./provider.ts";

const SLOT_NAMES: Record<string, string> = {
  FLEX: "W/R/T",
  SUPER_FLEX: "Q/W/R/T",
  WRRB_FLEX: "W/R",
  REC_FLEX: "W/T",
};

interface SleeperContext extends LeagueContext {
  /** roster_id → display team name / manager, used by every fetcher. */
  rosterName: Map<number, string>;
  rosterManager: Map<number, string | null>;
  myRosterId: number | null;
  /** Starting-lineup slots in order, Yahoo vocabulary (parallel to `starters`). */
  slots: string[];
}

let leagueCache: Promise<SleeperContext> | null = null;

/**
 * Resolve league + teams once per process. SLEEPER_LEAGUE_ID is required
 * (Sleeper has no auth, so there is no "my leagues" to discover from).
 * SLEEPER_USERNAME picks "my team"; without it the league-wide tools still
 * work and only get_roster / get_matchup refuse.
 */
export function resolveLeague(): Promise<SleeperContext> {
  leagueCache ??= (async () => {
    const leagueId = process.env.SLEEPER_LEAGUE_ID;
    if (!leagueId) {
      throw new Error(
        "SLEEPER_LEAGUE_ID is not set. Set it to the Sleeper league to serve " +
          "(the ID in the league URL); there is nothing to auto-discover without auth.",
      );
    }
    const [league, users, rosters] = await Promise.all([
      sleeperFetch(`/league/${leagueId}`),
      sleeperFetch(`/league/${leagueId}/users`),
      sleeperFetch(`/league/${leagueId}/rosters`),
    ]);
    if (!league) throw new Error(`Sleeper league ${leagueId} does not exist.`);

    const userById = new Map<string, any>(users.map((u: any) => [u.user_id, u]));
    const rosterName = new Map<number, string>();
    const rosterManager = new Map<number, string | null>();
    for (const r of rosters) {
      const u = userById.get(r.owner_id);
      rosterName.set(
        r.roster_id,
        u?.metadata?.team_name ?? u?.display_name ?? `Roster ${r.roster_id}`,
      );
      rosterManager.set(r.roster_id, u?.display_name ?? null);
    }

    const username = process.env.SLEEPER_USERNAME?.toLowerCase();
    const myUser = username
      ? users.find(
          (u: any) =>
            u.display_name?.toLowerCase() === username || u.user_id === username,
        )
      : undefined;
    if (username && !myUser) {
      throw new Error(
        `SLEEPER_USERNAME "${process.env.SLEEPER_USERNAME}" is not a member of ` +
          `${league.name}. Do not retry; fix the env var (league members: ` +
          `${users.map((u: any) => u.display_name).join(", ")}).`,
      );
    }
    const myRoster = myUser
      ? rosters.find((r: any) => r.owner_id === myUser.user_id)
      : undefined;

    const s = league.settings ?? {};
    const leg = s.leg || 1;
    const finished = league.status === "complete";
    return {
      league_key: leagueId,
      league_name: String(league.name),
      season: String(league.season),
      start_week: s.start_week || 1,
      end_week: s.last_scored_leg || 17,
      current_week: finished ? s.last_scored_leg || leg : leg,
      is_finished: finished,
      my_team_key: myRoster ? String(myRoster.roster_id) : "",
      my_team_name: myRoster ? rosterName.get(myRoster.roster_id)! : "",
      teams: rosters.map((r: any) => ({
        team_key: String(r.roster_id),
        name: rosterName.get(r.roster_id)!,
        manager: rosterManager.get(r.roster_id) ?? null,
      })),
      rosterName,
      rosterManager,
      myRosterId: myRoster?.roster_id ?? null,
      slots: (league.roster_positions as string[])
        .filter((p) => p !== "BN" && p !== "IR")
        .map((p) => SLOT_NAMES[p] ?? p),
    };
  })();
  return leagueCache;
}

function requireMyTeam(league: SleeperContext): number {
  if (league.myRosterId === null) {
    throw new Error(
      "SLEEPER_USERNAME is not set, so there is no 'my team' in this league. " +
        "Do not retry; set the env var, or use the league-wide tools " +
        "(get_week_results, get_standings, get_transactions).",
    );
  }
  return league.myRosterId;
}

/** One matchups call serves get_roster, get_matchup, get_week_results, and
 * getLeagueRosters for a week — memoize it per process (Yahoo needed 14). */
const matchupCache = new Map<number, Promise<any[]>>();
function fetchMatchups(leagueId: string, week: number): Promise<any[]> {
  let hit = matchupCache.get(week);
  if (!hit) {
    hit = sleeperFetch(`/league/${leagueId}/matchups/${week}`);
    matchupCache.set(week, hit);
  }
  return hit;
}

/** Matchup entry → the roster shape get_roster/getLeagueRosters promise. */
async function shapeRoster(league: SleeperContext, entry: any) {
  const players = await loadPlayers();
  const starterSlot = new Map<string, string>(
    (entry.starters as string[]).map((pid, i) => [pid, league.slots[i] ?? "?"]),
  );
  return (entry.players as string[])
    .filter((pid) => pid !== "0") // "0" = empty lineup slot
    .map((pid) => ({
      name: players[pid]?.name ?? pid,
      position: players[pid]?.pos ?? null,
      slot: starterSlot.get(pid) ?? "BN",
      nfl_team: players[pid]?.team ?? null,
      status: players[pid]?.injury ?? null,
      bye_week: null, // not in Sleeper league data; digest doesn't use it
      points: entry.players_points?.[pid] ?? 0,
    }));
}

export async function getRoster(week?: number) {
  const league = await resolveLeague();
  const myId = requireMyTeam(league);
  const w = resolveWeek(league, week);
  const entries = await fetchMatchups(league.league_key, w);
  const mine = entries.find((e) => e.roster_id === myId);
  if (!mine) throw new WeekNotAvailableError(w, league);
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    team: league.my_team_name,
    players: await shapeRoster(league, mine),
  };
}

export async function getLeagueRosters(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  const entries = await fetchMatchups(league.league_key, w);
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    teams: await Promise.all(
      entries.map(async (e) => ({
        team: league.rosterName.get(e.roster_id) ?? `Roster ${e.roster_id}`,
        manager: league.rosterManager.get(e.roster_id) ?? null,
        players: await shapeRoster(league, e),
      })),
    ),
  };
}

/** Pair entries by matchup_id and shape like Yahoo's matchup object.
 * No winner field upstream: higher points wins once the week is played. */
function shapeMatchups(league: SleeperContext, entries: any[], week: number) {
  const played = league.is_finished || week < league.current_week;
  const pairs = new Map<number, any[]>();
  for (const e of entries) {
    if (e.matchup_id == null) continue; // playoff bye / eliminated
    const pair = pairs.get(e.matchup_id) ?? [];
    pair.push(e);
    pairs.set(e.matchup_id, pair);
  }
  return [...pairs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, pair]) => {
      const is_tied = pair.length === 2 && played && pair[0].points === pair[1].points;
      const top = played
        ? [...pair].sort((a, b) => b.points - a.points)[0]
        : undefined;
      return {
        status: played ? "postevent" : "midevent",
        is_tied,
        winner:
          top && !is_tied ? league.rosterName.get(top.roster_id) ?? null : null,
        teams: pair.map((e) => ({
          team: league.rosterName.get(e.roster_id) ?? null,
          manager: league.rosterManager.get(e.roster_id) ?? null,
          points: e.points ?? null,
          projected_points: null, // not in Sleeper's documented API (spike gap #1)
          roster_id: e.roster_id as number,
        })),
      };
    });
}

export async function getMatchup(week?: number) {
  const league = await resolveLeague();
  const myId = requireMyTeam(league);
  const w = resolveWeek(league, week);
  const entries = await fetchMatchups(league.league_key, w);
  const matchup = shapeMatchups(league, entries, w).find((m) =>
    m.teams.some((t) => t.roster_id === myId),
  );
  if (!matchup) throw new WeekNotAvailableError(w, league);
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    my_team: league.my_team_name,
    status: matchup.status,
    is_tied: matchup.is_tied,
    winner: matchup.winner,
    teams: matchup.teams.map(({ roster_id, ...rest }) => rest),
  };
}

export async function getStandings() {
  const league = await resolveLeague();
  const rosters = await sleeperFetch(`/league/${league.league_key}/rosters`);
  const standings = rosters
    .map((r: any) => {
      const s = r.settings ?? {};
      const streakRaw: string | undefined = r.metadata?.streak; // "3L" → "L3"
      return {
        team: league.rosterName.get(r.roster_id) ?? `Roster ${r.roster_id}`,
        manager: league.rosterManager.get(r.roster_id) ?? null,
        is_my_team: r.roster_id === league.myRosterId,
        wins: s.wins ?? 0,
        losses: s.losses ?? 0,
        ties: s.ties ?? 0,
        points_for: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100,
        points_against: (s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100,
        streak: streakRaw ? `${streakRaw.at(-1)}${streakRaw.slice(0, -1)}` : null,
      };
    })
    .sort(
      (a: any, b: any) => b.wins - a.wins || b.points_for - a.points_for,
    )
    .map((t: any, i: number) => ({ rank: i + 1, ...t }));
  return {
    league: league.league_name,
    season: league.season,
    standings,
  };
}

/**
 * Sleeper transactions are per-week; walk back from the current week until
 * we have `count` (or run out of season). Failed waiver claims are noise —
 * the digest must not roast moves that never happened.
 */
export async function getTransactions(count = 10) {
  const league = await resolveLeague();
  const players = await loadPlayers();
  const teamOf = (rid: number) =>
    league.rosterName.get(rid) ?? `Roster ${rid}`;
  const out: any[] = [];
  for (let w = league.current_week; w >= league.start_week && out.length < count; w--) {
    const txns = await sleeperFetch(
      `/league/${league.league_key}/transactions/${w}`,
    );
    for (const t of txns) {
      if (t.status === "failed") continue;
      const adds: Record<string, number> = t.adds ?? {};
      const drops: Record<string, number> = t.drops ?? {};
      const pool = t.type === "waiver" ? "waivers" : "free agents";
      const pids = [...new Set([...Object.keys(adds), ...Object.keys(drops)])];
      out.push({
        type: t.type ?? null,
        status: t.status ?? null,
        date: new Date(t.status_updated ?? t.created)
          .toISOString()
          .slice(0, 10),
        players: pids.map((pid) => ({
          name: players[pid]?.name ?? pid,
          position: players[pid]?.pos ?? null,
          action:
            pid in adds && pid in drops
              ? "trade"
              : pid in adds
                ? "add"
                : "drop",
          from: pid in drops ? teamOf(drops[pid]) : pool,
          to: pid in adds ? teamOf(adds[pid]) : pool,
        })),
      });
      if (out.length >= count) break;
    }
  }
  return {
    league: league.league_name,
    season: league.season,
    transactions: out,
  };
}

export async function getWeekResults(week?: number) {
  const league = await resolveLeague();
  const w = resolveWeek(league, week);
  const entries = await fetchMatchups(league.league_key, w);
  return {
    league: league.league_name,
    season: league.season,
    week: w,
    matchups: shapeMatchups(league, entries, w).map((m) => ({
      ...m,
      teams: m.teams.map(({ roster_id, ...rest }) => rest),
    })),
  };
}
