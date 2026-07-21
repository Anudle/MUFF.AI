/**
 * MUFF-39 acceptance check: drive the DEPLOYED MCP server over Streamable
 * HTTP with a real MCP client, list the tools, call a few, and exercise the
 * auth + error paths. Exits non-zero on any failure.
 *
 * Usage (deploy.sh writes MCP_URL and MCP_AUTH_TOKEN into .env):
 *   npm run verify:remote
 *
 * Timing note: if the function hasn't been hit for a while the first
 * request pays the cold start (init + Secrets Manager read + Yahoo league
 * discovery); subsequent calls show the warm path.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL;
const token = process.env.MCP_AUTH_TOKEN;
if (!url || !token) {
  console.error("Set MCP_URL and MCP_AUTH_TOKEN (npm run deploy writes both to .env).");
  process.exit(1);
}

let failures = 0;

function check(label: string, passed: boolean, detail: string) {
  console.log(`${passed ? "✅" : "❌"} ${label} — ${detail}`);
  if (!passed) failures++;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const value = await fn();
  return [value, Date.now() - start];
}

// Wrong token must bounce before touching the MCP layer.
const [unauthorized] = await timed(() =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 0 }),
  }),
);
check("auth gate", unauthorized.status === 401, `bad token → HTTP ${unauthorized.status}`);

const client = new Client({ name: "muff-remote-verify", version: "0.1.0" });
const [, connectMs] = await timed(() =>
  client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  ),
);
console.log(`   connect + initialize: ${connectMs} ms`);

const [{ tools }, listMs] = await timed(() => client.listTools());
check(
  "tools/list",
  tools.length === 5,
  `${tools.length} tools in ${listMs} ms: ${tools.map((t) => t.name).join(", ")}`,
);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return JSON.parse(text) as { status: string; code?: string; message?: string; data?: any };
}

const [standings, standingsMs] = await timed(() => call("get_standings", {}));
check(
  "get_standings (cold-ish: Secrets Manager + league discovery)",
  standings.status === "ok" && standings.data.standings.length > 0,
  `${standings.data?.standings?.length} teams in ${standingsMs} ms, #1 = ${standings.data?.standings?.[0]?.team}`,
);

const [matchup, matchupMs] = await timed(() => call("get_matchup", { week: 1 }));
check(
  "get_matchup (warm path)",
  matchup.status === "ok" && matchup.data.teams.length === 2,
  `${matchup.data?.teams?.map((t: any) => `${t.team} ${t.points}`).join(" vs ")} in ${matchupMs} ms`,
);

const badWeek = await call("get_week_results", { week: 18 });
check(
  "error envelope survives the HTTP transport",
  badWeek.status === "error" && badWeek.code === "WEEK_NOT_AVAILABLE",
  `${badWeek.code}: ${badWeek.message?.slice(0, 80)}…`,
);

await client.close();
process.exit(failures === 0 ? 0 : 1);
