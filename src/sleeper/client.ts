/**
 * MUFF-49 — thin Sleeper HTTP client.
 *
 * The anti-Yahoo: no OAuth, no tokens, no key formats — the whole client is
 * one authenticated-by-nobody GET. Errors carry the HTTP status so
 * errors.ts can map them to the same structured codes the Yahoo path uses.
 * Rate limit is ~90 req/min per IP; our heaviest tool needs one call.
 */

const BASE = "https://api.sleeper.app/v1";

export class SleeperApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`Sleeper API ${status} on ${path}`);
    this.name = "SleeperApiError";
    this.status = status;
  }
}

export async function sleeperFetch(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new SleeperApiError(res.status, path);
  // Sleeper returns literal `null` (200) for unknown users/leagues.
  return res.json();
}
