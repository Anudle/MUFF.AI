/**
 * MUFF-15 — MCP server exposing Yahoo Fantasy tools (stdio transport).
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
 * NOTE: stdio transport — stdout belongs to the protocol. Log to stderr only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toToolError, type ToolResult } from "./errors.ts";
import {
  getMatchup,
  getRoster,
  getStandings,
  getTransactions,
  getWeekResults,
  resolveLeague,
} from "./yahoo-data.ts";

const server = new McpServer({ name: "muff-yahoo-fantasy", version: "0.1.0" });

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

const transport = new StdioServerTransport();
await server.connect(transport);

// Warm the league/team cache so the first tool call doesn't pay for discovery;
// errors here surface per-call with proper codes, so ignore them now.
resolveLeague()
  .then((l) =>
    console.error(
      `muff-yahoo-fantasy: serving ${l.league_name} ${l.season} as ${l.my_team_name}`,
    ),
  )
  .catch(() => {});
