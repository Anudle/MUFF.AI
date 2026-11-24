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
  /**
   * The run-in: average season scoring of this team's remaining opponents
   * (one entry per game left), and that figure minus the league's average
   * points per game. Negative = easier than average. Null once no games remain.
   */
  road: { opp_avg: number; vs_league: number } | null;
}

/**
 * The week's published digest, as the page shows it. Prose is the model's
 * (already gated and delivered to the chat); `prev_rank` is looked up in code
 * from last week's published rankings, exactly like the arrows in render.ts.
 */
export interface SiteDigest {
  week: number;
  headline: string;
  recap: string;
  power_rankings: { rank: number; team: string; comment: string; prev_rank: number | null }[];
}

export interface SeasonSnapshot {
  league: string;
  season: string;
  /** Last completed week included in the numbers. */
  through_week: number;
  generated_at: string;
  config: { regular_season_end: number; playoff_teams: number };
  /** Sorted by standing: wins (ties half), then head-to-head among the tied teams, then points for. */
  teams: TeamSeason[];
  /**
   * Head-to-head so far: `h2h[a][b]` is the games team a has won against team
   * b (a tie is half each), indexes into `teams`. The seeding tiebreak reads
   * it. Absent on snapshots written before the bracket existed (treated as no
   * games played).
   */
  h2h?: number[][];
  /** Regular-season games still to play; matchups are index pairs into `teams`. */
  remaining: { week: number; matchups: [number, number][] }[];
  /** The latest delivered digest. Absent until a delivering run has written one. */
  digest?: SiteDigest;
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
