/**
 * MUFF-71 — league format the providers don't expose. Source of truth is
 * docs/league-rules.md (8 of 14 teams qualify; playoffs are weeks 15–17, so
 * the regular season ends after week 14). Yahoo's `end_week` includes the
 * playoffs, which is why it can't stand in for REGULAR_SEASON_END.
 */
export const REGULAR_SEASON_END = 14;
export const PLAYOFF_TEAMS = 8;
