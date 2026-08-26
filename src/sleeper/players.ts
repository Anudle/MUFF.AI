/**
 * MUFF-49 — the players map: Sleeper's one genuinely awkward surface.
 *
 * Every league endpoint speaks player IDs; names live in `/players/nfl`,
 * which is ~14.6MB of 53-field player objects. Context-management tiering
 * (CCA-F Domain 5):
 *   tier 1: 14.6MB upstream blob — fetched at most once per day
 *   tier 2: ~800KB trimmed map (id → name/pos/team/injury) — held in memory,
 *           cached on disk for 24h (.cache/, gitignored)
 *   tier 3: the ~15 names a tool answer actually references
 * Step 3 of MUFF-49 swaps the disk cache for S3 so Lambda gets tier 2
 * without ever paying for tier 1 on a warm path.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { sleeperFetch } from "./client.ts";

export interface PlayerLite {
  name: string;
  pos: string | null;
  team: string | null;
  injury: string | null;
}

const CACHE_FILE = process.env.SLEEPER_PLAYERS_CACHE ?? ".cache/sleeper-players.json";
const TTL_MS = 24 * 60 * 60 * 1000;

let playersCache: Promise<Record<string, PlayerLite>> | null = null;

export function loadPlayers(): Promise<Record<string, PlayerLite>> {
  playersCache ??= (async () => {
    const fresh = await stat(CACHE_FILE)
      .then((s) => Date.now() - s.mtimeMs < TTL_MS)
      .catch(() => false);
    if (fresh) return JSON.parse(await readFile(CACHE_FILE, "utf8"));

    const raw = await sleeperFetch("/players/nfl");
    const trimmed: Record<string, PlayerLite> = {};
    for (const [id, p] of Object.entries<any>(raw)) {
      trimmed[id] = {
        name: p.full_name ?? p.last_name ?? id, // team defenses have no full_name
        pos: p.position ?? null,
        team: p.team ?? null,
        injury: p.injury_status ?? null,
      };
    }
    await mkdir(CACHE_FILE.replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(trimmed));
    return trimmed;
  })();
  return playersCache;
}
