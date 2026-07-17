/**
 * MUFF-15 acceptance check: drive the MCP server over stdio with a real MCP
 * client (the SDK's own), list the tools, call all five, and exercise the
 * WEEK_NOT_AVAILABLE error path. Exits non-zero on any failure.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "muff-verify", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--env-file=.env", "--experimental-strip-types", "src/mcp/server.ts"],
  }),
);

let failures = 0;

function check(label: string, passed: boolean, detail: string) {
  console.log(`${passed ? "✅" : "❌"} ${label} — ${detail}`);
  if (!passed) failures++;
}

const { tools } = await client.listTools();
check(
  "tools/list",
  tools.length === 5,
  `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return JSON.parse(text) as {
    status: string;
    code?: string;
    message?: string;
    data?: any;
  };
}

const roster = await call("get_roster", { week: 1 });
check(
  "get_roster",
  roster.status === "ok" && roster.data.players.length > 0,
  `${roster.data?.team}: ${roster.data?.players?.length} players, week ${roster.data?.week}`,
);

const matchup = await call("get_matchup", { week: 1 });
check(
  "get_matchup",
  matchup.status === "ok" && matchup.data.teams.length === 2,
  `${matchup.data?.teams?.map((t: any) => `${t.team} ${t.points}`).join(" vs ")}`,
);

const standings = await call("get_standings", {});
check(
  "get_standings",
  standings.status === "ok" && standings.data.standings.length > 0,
  `${standings.data?.standings?.length} teams, #1 = ${standings.data?.standings?.[0]?.team}`,
);

const tx = await call("get_transactions", { count: 3 });
check(
  "get_transactions",
  tx.status === "ok" && tx.data.transactions.length > 0,
  `${tx.data?.transactions?.length} transactions, latest ${tx.data?.transactions?.[0]?.date}`,
);

const results = await call("get_week_results", { week: 1 });
check(
  "get_week_results",
  results.status === "ok" && results.data.matchups.length > 0,
  `${results.data?.matchups?.length} matchups in week ${results.data?.week}`,
);

const badWeek = await call("get_roster", { week: 17 }).then(() =>
  call("get_week_results", { week: 18 }),
);
check(
  "error path (week 18 on a 17-week season)",
  badWeek.status === "error" && badWeek.code === "WEEK_NOT_AVAILABLE",
  `${badWeek.code}: ${badWeek.message?.slice(0, 80)}…`,
);

await client.close();
process.exit(failures === 0 ? 0 : 1);
