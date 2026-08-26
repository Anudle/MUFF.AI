/**
 * MUFF-49 — the provider contract.
 *
 * Everything shared between fantasy data providers (yahoo-data.ts,
 * sleeper-data.ts) lives here: the league context shape every provider must
 * resolve, and the week-range error both raise. The tools in build-server.ts
 * and the digest's facts.ts only ever see these shapes — that's what makes
 * the backend swappable by config (FANTASY_PROVIDER, see data.ts).
 */

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
  /** Every team in the league (MUFF-38: digest needs league-wide rosters). */
  teams: { team_key: string; name: string; manager: string | null }[];
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

export function resolveWeek(league: LeagueContext, week?: number): number {
  if (week === undefined) return league.current_week;
  if (week < league.start_week || week > league.current_week) {
    throw new WeekNotAvailableError(week, league);
  }
  return week;
}
