/**
 * MUFF-49 — the players map: Sleeper's one genuinely awkward surface.
 *
 * Every league endpoint speaks player IDs; names live in `/players/nfl`,
 * which is ~14.6MB of 53-field player objects. Context-management tiering
 * (CCA-F Domain 5):
 *   tier 1: 14.6MB upstream blob — fetched at most once per day, ideally
 *           only by the scheduled sync Lambda (infra/deploy-players-sync.sh)
 *   tier 2: ~760KB trimmed map (id → name/pos/team/injury) — lives in the
 *           blob store (S3 on Lambda, data/ locally) and in process memory
 *   tier 3: the ~15 names a tool answer actually references
 *
 * The read path is a write-through cache: fresh store copy → use it (the
 * daily sync makes this the only path warm infrastructure ever takes);
 * stale/missing → sync inline; sync failed but a stale copy exists → serve
 * stale, because day-old names beat a dead digest.
 */

import { store, storeLabel } from "../store.ts";
import { sleeperFetch } from "./client.ts";

export interface PlayerLite {
  name: string;
  pos: string | null;
  team: string | null;
  injury: string | null;
}

/** Envelope carries its own timestamp: S3 has no mtime the store exposes,
 * and this keeps freshness logic identical across FileStore and S3Store. */
interface PlayersBlob {
  fetched_at: string;
  players: Record<string, PlayerLite>;
}

export const PLAYERS_KEY = "players/sleeper-nfl.json";
const TTL_MS = 24 * 60 * 60 * 1000;

/** Fetch tier 1, trim to tier 2, write to the store. The only place the
 * 14.6MB blob is ever pulled. Returns stats for sync logs. */
export async function syncPlayers(): Promise<{
  players: Record<string, PlayerLite>;
  count: number;
  bytes: number;
}> {
  const raw = await sleeperFetch("/players/nfl");
  const players: Record<string, PlayerLite> = {};
  for (const [id, p] of Object.entries<any>(raw)) {
    players[id] = {
      name: p.full_name ?? p.last_name ?? id, // team defenses have no full_name
      pos: p.position ?? null,
      team: p.team ?? null,
      injury: p.injury_status ?? null,
    };
  }
  const blob: PlayersBlob = { fetched_at: new Date().toISOString(), players };
  await store.write(PLAYERS_KEY, blob);
  return { players, count: Object.keys(players).length, bytes: JSON.stringify(blob).length };
}

let playersCache: Promise<Record<string, PlayerLite>> | null = null;

export function loadPlayers(): Promise<Record<string, PlayerLite>> {
  playersCache ??= (async () => {
    const cached = await store.read<PlayersBlob>(PLAYERS_KEY);
    const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
    if (cached && age < TTL_MS) return cached.players;

    try {
      return (await syncPlayers()).players;
    } catch (e) {
      if (!cached) throw e;
      console.warn(
        `players sync failed (${(e as Error).message}); serving stale map ` +
          `from ${storeLabel}${PLAYERS_KEY} (${Math.round(age / 3_600_000)}h old)`,
      );
      return cached.players;
    }
  })();
  return playersCache;
}
