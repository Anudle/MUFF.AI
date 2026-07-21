/**
 * MUFF-15 — structured tool errors.
 *
 * Tools never raise: every handler returns either {status:"ok", data} or
 * {status:"error", code, message}. The message tells the agent what to DO
 * (retry / don't retry / ask the user), not just what went wrong — the
 * agent has to be able to reason about failures.
 */

import { YahooApiError } from "../yahoo/client.ts";
import { WeekNotAvailableError } from "./yahoo-data.ts";

export type ErrorCode =
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "WEEK_NOT_AVAILABLE"
  | "LEAGUE_NOT_FOUND"
  | "UPSTREAM_ERROR";

export type ToolResult<T> =
  | { status: "ok"; data: T }
  | { status: "error"; code: ErrorCode; message: string };

export function ok<T>(data: T): ToolResult<T> {
  return { status: "ok", data };
}

export function err<T = never>(code: ErrorCode, message: string): ToolResult<T> {
  return { status: "error", code, message };
}

/** Map any thrown error to the structured envelope. Never rethrows. */
export function toToolError<T = never>(e: unknown): ToolResult<T> {
  if (e instanceof WeekNotAvailableError) {
    // The message already carries the valid range + retry guidance.
    return err("WEEK_NOT_AVAILABLE", e.message);
  }
  if (e instanceof YahooApiError) {
    switch (e.status) {
      case 400:
        // Yahoo 400s on out-of-range weeks and malformed keys alike.
        return err(
          "WEEK_NOT_AVAILABLE",
          "Yahoo rejected the request — the requested week or resource does not exist. Do not retry with the same arguments; omit `week` to use the current week.",
        );
      case 401:
        return err(
          "AUTH_EXPIRED",
          "Yahoo auth failed even after token refresh. Do not retry; tell the user to re-run `npm run auth`.",
        );
      case 404:
        return err(
          "LEAGUE_NOT_FOUND",
          "League, team, or resource not found. Do not retry with the same arguments; check the league is one the user actually plays in.",
        );
      case 429:
      case 999: // Yahoo's legacy rate-limit status
        return err(
          "RATE_LIMITED",
          "Yahoo is rate limiting us. Safe to retry after waiting ~60 seconds.",
        );
      default:
        return err(
          "UPSTREAM_ERROR",
          `Yahoo returned HTTP ${e.status}. Transient upstream problem — safe to retry once; if it persists, report to the user.`,
        );
    }
  }
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("No .tokens.json") || message.includes("npm run auth")) {
    return err(
      "AUTH_EXPIRED",
      "No Yahoo tokens on this machine. Do not retry; tell the user to run `npm run auth` first.",
    );
  }
  return err(
    "UPSTREAM_ERROR",
    `Unexpected failure: ${message}. Safe to retry once; if it persists, report to the user.`,
  );
}
