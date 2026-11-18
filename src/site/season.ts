/**
 * MUFF-71 — the fetch half of the league site (derive.ts is the pure half).
 * Goes through the provider seam like every other consumer, so the snapshot
 * works on Yahoo or Sleeper and simply fails (non-fatally, see publish.ts)
 * in fixture mode, which has no future schedule.
 *
 * It re-reads each played week from the provider rather than walking the run
 * archive: the digest Lambda's role cannot list runs/, and the provider is
 * the source the archive was copied from anyway.
 */

import { getSchedule, getWeekResults, resolveLeague } from "../mcp/data.ts";
import { REGULAR_SEASON_END } from "./config.ts";
import type { SeasonInputs } from "./types.ts";

type WeekResults = Awaited<ReturnType<typeof getWeekResults>>;

/** A week counts only when every game is final and every score is present. */
function isComplete(results: WeekResults): boolean {
  return (
    results.matchups.length > 0 &&
    results.matchups.every(
      (m) => m.status === "postevent" && m.teams.length === 2 && m.teams.every((t) => t.team && t.points !== null),
    )
  );
}

export async function gatherSeasonInputs(): Promise<SeasonInputs> {
  const league = await resolveLeague();
  const lastFetchable = Math.min(league.current_week, REGULAR_SEASON_END);

  // Four at a time, same rate-limit caution as getLeagueRosters.
  const weeks: WeekResults[] = [];
  for (let w = league.start_week; w <= lastFetchable; w += 4) {
    const batch: number[] = [];
    for (let x = w; x < w + 4 && x <= lastFetchable; x++) batch.push(x);
    weeks.push(...(await Promise.all(batch.map((x) => getWeekResults(x)))));
  }

  // Played = the unbroken run of complete weeks from the start.
  const firstOpen = weeks.findIndex((wk) => !isComplete(wk));
  const played = firstOpen === -1 ? weeks : weeks.slice(0, firstOpen);
  const nextWeek = league.start_week + played.length;
  const remaining = nextWeek <= REGULAR_SEASON_END ? await getSchedule(nextWeek, REGULAR_SEASON_END) : [];

  return {
    league: league.league_name,
    season: league.season,
    teams: league.teams.map((t) => ({ name: t.name, manager: t.manager })),
    played: played.map((wk) => ({
      week: wk.week,
      matchups: wk.matchups.map((m) => m.teams.map((t) => ({ team: String(t.team), points: Number(t.points) }))),
    })),
    remaining,
  };
}
