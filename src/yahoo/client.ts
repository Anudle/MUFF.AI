/**
 * ANU-11 — Authenticated Yahoo Fantasy API client.
 *
 * Token persistence: local JSON file for dev (gitignored).
 * In the Lambda deployment this swaps to Secrets Manager — the
 * load/save functions are the seam where that swap happens.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  refreshAccessToken,
  isExpired,
  type TokenSet,
} from "./oauth.ts";

const TOKENS_PATH = process.env.TOKENS_PATH ?? ".tokens.json";
const API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

export function saveTokens(tokens: TokenSet): void {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function loadTokens(): TokenSet {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(
      `No ${TOKENS_PATH} found — run \`npm run auth\` first to complete the OAuth flow.`,
    );
  }
  return JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as TokenSet;
}

/** Returns a valid access token, refreshing (and persisting) if needed. */
async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (isExpired(tokens)) {
    tokens = await refreshAccessToken(tokens.refresh_token);
    saveTokens(tokens);
  }
  return tokens.access_token;
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
