/**
 * MUFF-71 — the league site's one data contract: the season snapshot the
 * digest run writes to `site/season.json` and the static page reads.
 *
 * Types only, no imports: this file is bundled into the browser (web/app.ts)
 * as well as used on the server, so nothing Node-specific may live here.
 */

export interface TeamSeason {
  team: string;
  manager: string | null;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  /** One score per completed week, oldest first. */
  scores: number[];
  /** Record if this team had played every other team every week. */
  all_play: { wins: number; losses: number; ties: number };
  /** Wins a team with these scores "should" have: sum of weekly all-play win rates. */
  expected_wins: number;
  /** Actual wins (ties count half) minus expected_wins. Positive = lucky. */
  luck: number;
}

export interface SeasonSnapshot {
  league: string;
  season: string;
  /** Last completed week included in the numbers. */
  through_week: number;
  generated_at: string;
  config: { regular_season_end: number; playoff_teams: number };
  /** Sorted by standing: wins (ties half), then points for. */
  teams: TeamSeason[];
  /** swap[i][j] = wins team i would have with team j's schedule (ties count half). */
  swap: number[][];
  /** Regular-season games still to play; matchups are index pairs into `teams`. */
  remaining: { week: number; matchups: [number, number][] }[];
}

/** What deriveSeason needs — plain shapes, so tests need no provider. */
export interface SeasonInputs {
  league: string;
  season: string;
  teams: { name: string; manager: string | null }[];
  /** Completed weeks only, oldest first; every team appears once per week. */
  played: { week: number; matchups: { team: string; points: number }[][] }[];
  /** Unplayed regular-season weeks; each matchup is two team names. */
  remaining: { week: number; matchups: string[][] }[];
}
