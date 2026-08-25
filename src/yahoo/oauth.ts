/**
 * ANU-11 — Yahoo OAuth2: 3-legged flow + auto-refresh.
 *
 * Yahoo specifics worth knowing:
 *  - Auth URL:  https://api.login.yahoo.com/oauth2/request_auth
 *  - Token URL: https://api.login.yahoo.com/oauth2/get_token
 *  - Yahoo's app console no longer accepts "oob" as a registered redirect
 *    URI (must be a URL). We register an unroutable https://localhost:8000
 *    callback: after consent, Yahoo redirects the browser there, the load
 *    fails (nothing's listening), and the user copies the `code` query
 *    param out of the dead URL and pastes it back — same UX as oob.
 *  - Access tokens live ~1 hour; refresh tokens are long-lived.
 *  - Token endpoint wants HTTP Basic auth (client_id:client_secret).
 *  - Scope: `fspt-r` is Fantasy Sports read. Historically the consent flow
 *    worked without any `scope` param — permissions came from the app's
 *    console config alone — but a token minted that way carries no fantasy
 *    grant if the app config is the thing that's wrong, and every call comes
 *    back 403. Asking for the scope explicitly makes the grant visible at
 *    consent time: Yahoo either shows the Fantasy Sports permission on the
 *    approval screen, or refuses the scope outright. That turns a silent
 *    403-on-everything into a diagnosable failure.
 */

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const REDIRECT_URI = "https://localhost:8000";
/** Fantasy Sports read. `fspt-w` would be read/write — Yahoo grants read only. */
const SCOPE = "fspt-r";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** Unix ms timestamp when the access token expires. */
  expires_at: number;
}

interface YahooTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} — copy .env.example to .env and fill it in.`);
  return v;
}

function basicAuthHeader(): string {
  const id = requireEnv("YAHOO_CLIENT_ID");
  const secret = requireEnv("YAHOO_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

/** Step 1: URL the human opens in a browser to grant access. */
export function buildAuthUrl(redirectUri = REDIRECT_URI, scope = SCOPE): string {
  const params = new URLSearchParams({
    client_id: requireEnv("YAHOO_CLIENT_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    language: "en-us",
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Yahoo token endpoint ${res.status}: ${text}`);
  }
  const json = (await res.json()) as YahooTokenResponse;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    // Refresh 60s early to avoid using a token that dies mid-request.
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
}

/** Step 2: exchange the pasted authorization code for tokens. */
export function exchangeCode(code: string, redirectUri = REDIRECT_URI): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: redirectUri,
  });
}

/** Step 3 (forever after): mint a fresh access token from the refresh token. */
export function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export function isExpired(tokens: TokenSet): boolean {
  return Date.now() >= tokens.expires_at;
}
