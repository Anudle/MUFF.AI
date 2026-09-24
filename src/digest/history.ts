/**
 * MUFF-38/43 — persisted digest state across weekly runs.
 *
 * Power-ranking arrows need what was PUBLISHED last week — regenerating
 * week N-1 on the fly could rank differently and the arrows would lie.
 * So each run persists its rankings; the next run reads them.
 *
 * MUFF-40 adds the Game of the Week poll to the same blob: the run that
 * posts it records where it lives (chat + message id), and the run that
 * closes it records the tally, so a re-run of a week never re-closes or
 * re-counts.
 *
 * The local-file-vs-S3 seam moved to store.ts in MUFF-16 (the run archive
 * needed the same one).
 */

import { store } from "../store.ts";

/** Final vote counts, in the poll's option order. What facts.ts turns into percentages. */
export interface PollTally {
  options: { team: string; votes: number }[];
  closed_at: string;
}

export interface PostedPoll {
  chat_id: number;
  message_id: number;
  poll_id: string;
  /** The week the poll is ABOUT (the upcoming one when it was posted). */
  week: number;
  /** Team names in option order — the key for mapping Telegram's counts back to facts. */
  options: string[];
  posted_at: string;
  /** Set once the next run has closed the poll. */
  tally?: PollTally;
}

interface History {
  power_rankings: Record<string, { rank: number; team: string }[]>; // "season:week"
  /** Absent on blobs written before MUFF-40. */
  polls?: Record<string, PostedPoll>; // "season:week" — the week polled
}

const KEY = process.env.HISTORY_KEY ?? "digest-history.json";

export async function loadPowerRankings(
  season: string,
  week: number,
): Promise<{ rank: number; team: string }[] | null> {
  const history = await store.read<History>(KEY);
  return history?.power_rankings[`${season}:${week}`] ?? null;
}

export async function savePowerRankings(
  season: string,
  week: number,
  rankings: { rank: number; team: string }[],
): Promise<void> {
  const history = (await store.read<History>(KEY)) ?? { power_rankings: {} };
  history.power_rankings[`${season}:${week}`] = rankings.map(({ rank, team }) => ({ rank, team }));
  await store.write(KEY, history);
}

export async function loadPoll(season: string, week: number): Promise<PostedPoll | null> {
  const history = await store.read<History>(KEY);
  return history?.polls?.[`${season}:${week}`] ?? null;
}

export async function savePoll(season: string, week: number, poll: PostedPoll): Promise<void> {
  const history = (await store.read<History>(KEY)) ?? { power_rankings: {} };
  history.polls ??= {};
  history.polls[`${season}:${week}`] = poll;
  await store.write(KEY, history);
}
