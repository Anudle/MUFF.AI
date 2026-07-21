/**
 * ANU-11 — Authenticated Yahoo Fantasy API client.
 *
 * Token persistence goes through the TokenStore seam (token-store.ts):
 * local JSON file in dev, Secrets Manager on Lambda (MUFF-39). Tokens are
 * cached in module scope so a warm Lambda container only reads the secret
 * once, not per tool call.
 */

import {
  refreshAccessToken,
  isExpired,
  type TokenSet,
} from "./oauth.ts";
import { tokenStore } from "./token-store.ts";

const API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

let cached: TokenSet | null = null;

export async function saveTokens(tokens: TokenSet): Promise<void> {
  cached = tokens;
  await tokenStore.save(tokens);
}

/** Returns a valid access token, refreshing (and persisting) if needed. */
async function getAccessToken(): Promise<string> {
  cached ??= await tokenStore.load();
  if (isExpired(cached)) {
    // Yahoo refresh tokens don't rotate, so concurrent refreshes from
    // parallel Lambda containers are safe — last write just wins.
    cached = await refreshAccessToken(cached.refresh_token);
    await tokenStore.save(cached);
  }
  return cached.access_token;
}

/** Thrown on non-2xx Yahoo responses; carries the HTTP status so callers
 *  (the MCP error mapper in ANU-15) can translate to structured errors. */
export class YahooApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, body: string) {
    super(`Yahoo API ${status} for ${path}: ${body.slice(0, 500)}`);
    this.name = "YahooApiError";
    this.status = status;
    this.path = path;
  }
}

/** GET a Yahoo Fantasy resource path, returning parsed JSON. */
export async function yahooFetch(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${API_BASE}/${path}${path.includes("?") ? "&" : "?"}format=json`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new YahooApiError(res.status, path, await res.text());
  }
  return res.json();
}

/**
 * Smoke-test call: the logged-in user's NFL leagues.
 * Yahoo's JSON is deeply nested and index-keyed; we return it raw here and
 * let callers (and later, MCP tools in ANU-15) shape it.
 */
export function getNflLeagues(): Promise<unknown> {
  return yahooFetch("users;use_login=1/games;game_keys=nfl/leagues");
}
