/**
 * MUFF-72 — shapes for the free-agent scout. Kept apart from the provider so
 * the pure derive (and its tests) import no data layer at all.
 */

export const POSITIONS = ["QB", "WR", "RB", "TE", "K", "DEF"] as const;
export type Position = (typeof POSITIONS)[number];

/** One player as the provider returns it (`getFreeAgents`). */
export interface PoolPlayer {
  player_key: string;
  name: string | null;
  /** Yahoo display position; may be dual, e.g. "WR,RB". */
  position: string | null;
  nfl_team: string | null;
  status: string | null;
  bye_week: number | null;
  /** League-scored points for the scouted week; null if none reported. */
  points: number | null;
  season_points: number | null;
}

export interface RosterPlayer extends PoolPlayer {
  /** Lineup slot that week: a starting slot, "BN" or "IR". */
  slot: string | null;
}

export interface ScoutInputs {
  league: string;
  season: string;
  week: number;
  /** The week can still change (it is the league's current week). */
  live: boolean;
  team: string;
  roster: RosterPlayer[];
  free_agents: PoolPlayer[];
}

export interface ScoutOptions {
  /** A free agent must score at least this in the week to be worth a ping. */
  minPoints: Record<Position, number>;
  /** ...and beat my weakest player at the position by at least this. */
  minGain: number;
  /**
   * Positions where one good week is mostly noise (K, DEF): a ping also needs
   * the free agent to be ahead of my player over the season.
   */
  needSeasonLead: Position[];
  /** Pings per position per run, best gain first; the board still shows the rest. */
  maxAlertsPerPosition: number;
  /** Rows kept per position on the board. */
  boardSize: number;
}

/** A free agent measured against the player he would replace. */
export interface Candidate {
  player_key: string;
  name: string;
  /** The board he is listed under (one of his positions). */
  position: Position;
  nfl_team: string | null;
  status: string | null;
  points: number;
  season_points: number | null;
  /** My weakest player at the position, or null if I roster none. */
  drop: string | null;
  drop_points: number | null;
  drop_season_points: number | null;
  /** points − drop_points (a missing drop counts as 0). */
  week_gain: number;
  /** season_points − drop_season_points; null if either side is unknown. */
  season_gain: number | null;
  alert: boolean;
}

export interface PositionBoard {
  position: Position;
  drop: string | null;
  candidates: Candidate[];
}

export interface Scout {
  league: string;
  season: string;
  week: number;
  live: boolean;
  team: string;
  board: PositionBoard[];
  /** Alert-worthy candidates, one per player, best gain first. */
  alerts: Candidate[];
}

/** What `scout/<season>-wNN.json` holds. */
export interface ScoutSnapshot {
  as_of: string;
  /** player_keys already sent to Telegram this week. */
  alerted: string[];
  scout: Scout;
}
