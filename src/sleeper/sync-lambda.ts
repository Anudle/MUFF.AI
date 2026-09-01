/**
 * MUFF-49 step 3 — Lambda entry for the daily Sleeper players sync.
 *
 * EventBridge Scheduler → this handler → syncPlayers(): pull the 14.6MB
 * `/players/nfl` blob, trim it to the ~760KB tier-2 map, write it to
 * s3://$HISTORY_BUCKET/players/sleeper-nfl.json. Everything that *serves*
 * traffic (MCP server, digest) then reads the trimmed map and never pays
 * the tier-1 fetch. Failures are loud: a throw here is a failed invocation
 * in CloudWatch, and the read path degrades to serving the stale map.
 */

import { PLAYERS_KEY, syncPlayers } from "./players.ts";
import { storeLabel } from "../store.ts";

export async function handler(): Promise<{ count: number; bytes: number }> {
  const { count, bytes } = await syncPlayers();
  console.log(
    `synced ${count} players (${(bytes / 1024).toFixed(0)}KB trimmed) → ${storeLabel}${PLAYERS_KEY}`,
  );
  return { count, bytes };
}
