/**
 * MUFF-15/39 — MCP server factory: the five Yahoo Fantasy tools plus the
 * MUFF-63 league-history search, transport-agnostic.
 *
 * Design rules (the CCA-F material this lab exists to exercise):
 *  - Five narrow read-only tools, one job each — no mega "get_league_data".
 *  - Descriptions say what the tool does, when to use it, what it returns,
 *    and its constraints, so the model can route without guessing.
 *  - League, team, and current week resolve server-side: the agent never
 *    sees Yahoo's nnn.l.nnnnn.t.n key format.
 *  - Handlers never raise. Every response is {status:"ok",data} or
 *    {status:"error",code,message}; messages tell the agent what to do next.
 *
 * This is a FACTORY (MUFF-39): stdio connects one server for the process
 * lifetime; the stateless HTTP transport builds a fresh server per request.
 * Registration is cheap — the expensive league discovery is cached at the
 * module level in yahoo-data.ts, so it survives across requests in a warm
 * Lambda container regardless of how many servers we build.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toToolError, type ToolResult } from "./errors.ts";
import {
  getMatchup,
  getRoster,
  getStandings,
  getTransactions,
  getWeekResults,
} from "./data.ts";
import { PROVIDER } from "./data.ts";
import { searchHistory } from "../rag/index.ts";

const weekParam = z
  .number()
  .int()
  .min(1)
  .max(18)
  .optional()
  .describe(
    "NFL fantasy week. Omit for the current week (or final week of a finished season).",
  );

/** Run a fetcher, wrap the outcome in the envelope, emit as MCP content. */
async function run<T>(fetcher: () => Promise<T>) {
  let result: ToolResult<T>;
  try {
    result = { status: "ok", data: await fetcher() };
  } catch (e) {
    result = toToolError(e);
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.status === "error",
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: `muff-${PROVIDER}-fantasy`, version: "0.2.0" });

  server.registerTool(
    "get_roster",
    {
      title: "Get my roster",
      description:
        "The user's own fantasy roster for one week: every player's name, position, " +
        "lineup slot (BN = benched), NFL team, injury status, bye week, and fantasy " +
        "points scored. Use for questions about the user's lineup, bench, injuries, " +
        "or how individual players on their team performed. Only covers the user's " +
        "team — for other teams' scores use get_week_results, for league-wide " +
        "records use get_standings. Read-only.",
      inputSchema: { week: weekParam },
    },
    ({ week }) => run(() => getRoster(week)),
  );

  server.registerTool(
    "get_matchup",
    {
      title: "Get my matchup",
      description:
        "The user's head-to-head matchup for one week: both teams' names, managers, " +
        "actual and projected points, and the winner (once played). Use for 'who am " +
        "I playing', 'did I win', or margin-of-victory questions about the user's " +
        "own game. For every matchup in the league that week, use get_week_results " +
        "instead. Read-only.",
      inputSchema: { week: weekParam },
    },
    ({ week }) => run(() => getMatchup(week)),
  );

  server.registerTool(
    "get_standings",
    {
      title: "Get league standings",
      description:
        "Full-season league standings: every team's rank, manager, W-L-T record, " +
        "points for/against, and current streak, with the user's team flagged " +
        "(is_my_team). Use for rankings, records, playoff-picture, or 'how is X " +
        "doing this season' questions. Season-cumulative — takes no week argument; " +
        "for a single week's scores use get_week_results. Read-only.",
      inputSchema: {},
    },
    () => run(() => getStandings()),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get recent transactions",
      description:
        "The league's most recent roster moves (adds, drops, trades), newest first: " +
        "transaction type, date, and each player moved with from/to. Use for waiver-" +
        "wire activity, 'who picked up X', or trade questions. Covers all teams, not " +
        "just the user's. Read-only.",
      inputSchema: {
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many transactions to return, newest first. Default 10."),
      },
    },
    ({ count }) => run(() => getTransactions(count)),
  );

  server.registerTool(
    "get_week_results",
    {
      title: "Get week results (all matchups)",
      description:
        "Every matchup in the league for one week: both teams, managers, actual and " +
        "projected points, and winners. Use for league-wide weekly recaps, highest/" +
        "lowest scorer of the week, or blowout/upset questions — this is the digest's " +
        "primary data source. For just the user's own game use get_matchup. Read-only.",
      inputSchema: { week: weekParam },
    },
    ({ week }) => run(() => getWeekResults(week)),
  );

  // MUFF-63: the one tool that reads the past instead of the provider. The
  // five above answer "what happened"; this answers "what did we SAY about
  // it" — the archived digests, which is where the callbacks live.
  server.registerTool(
    "search_league_history",
    {
      title: "Search league history (past digests + rules)",
      description:
        "Semantic search over every past weekly digest this league has received " +
        "(headlines, recaps, and per-team power-ranking comments, each tagged with " +
        "season and week) plus the written league rules (scoring, roster, playoffs). " +
        "Use for 'has this happened before', 'what did the digest say about X in " +
        "week N', streaks or storylines across weeks, and any rules question. " +
        "Returns the k best-matching chunks, highest score first, each with its " +
        "text, section, season/week (absent for rules) and team where applicable. " +
        "Quote or paraphrase the returned text — a chunk is evidence for a claim " +
        "about the past, nothing else is. Not a live stats source: for this " +
        "week's numbers use the other tools. Read-only.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Natural-language question or topic, e.g. 'worst beat of the season' or 'playoff format'."),
        k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many chunks to return. Default 5."),
      },
    },
    ({ query, k }) => run(async () => ({ query, hits: await searchHistory(query, k ?? 5) })),
  );

  return server;
}
