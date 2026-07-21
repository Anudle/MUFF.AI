/**
 * MUFF-15 — stdio entry point for the MCP server (local dev / `claude mcp add`).
 *
 * Tool registration lives in build-server.ts so this file is only the
 * transport binding. The HTTP/Lambda twin is http.ts + lambda.ts (MUFF-39).
 *
 * NOTE: stdio transport — stdout belongs to the protocol. Log to stderr only.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build-server.ts";
import { resolveLeague } from "./yahoo-data.ts";

const server = buildServer();
await server.connect(new StdioServerTransport());

// Warm the league/team cache so the first tool call doesn't pay for discovery;
// errors here surface per-call with proper codes, so ignore them now.
resolveLeague()
  .then((l) =>
    console.error(
      `muff-yahoo-fantasy: serving ${l.league_name} ${l.season} as ${l.my_team_name}`,
    ),
  )
  .catch(() => {});
