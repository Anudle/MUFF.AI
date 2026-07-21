/**
 * MUFF-39 — run the Streamable HTTP MCP server locally (default port 3939).
 *
 * Exercises the exact handler Lambda runs (src/mcp/http.ts), so transport
 * bugs surface here before a deploy. Try it with the Inspector:
 *
 *   npx @modelcontextprotocol/inspector
 *   → transport "Streamable HTTP", URL http://localhost:3939/mcp
 *
 * Set MCP_AUTH_TOKEN in .env to also exercise the bearer check locally.
 */

import { createServer } from "node:http";
import { handleMcpHttp } from "../src/mcp/http.ts";

const port = Number(process.env.PORT ?? 3939);

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }

    const response = await handleMcpHttp(
      new Request(`http://localhost:${port}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
      }),
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (e) {
    console.error("request failed:", e);
    res.writeHead(500).end();
  }
}).listen(port, () => {
  console.error(`muff-yahoo-fantasy (Streamable HTTP) on http://localhost:${port}/mcp`);
});
