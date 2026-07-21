/**
 * MUFF-39 — Streamable HTTP entry for the MCP server (Lambda-compatible).
 *
 * Transport notes (CCA-F: MCP's two transports are stdio and Streamable HTTP;
 * this is the remote one):
 *
 *  - STATELESS mode: `sessionIdGenerator: undefined` disables sessions, and
 *    every POST builds a fresh McpServer + transport. Lambda containers
 *    appear and vanish and concurrent requests may land on different
 *    containers, so server-held session state can't work. The client still
 *    sends `initialize` first — it just may be answered by a different
 *    container than the ones that answer its tool calls, which is fine
 *    because nothing in our server depends on per-session state.
 *
 *  - `enableJsonResponse: true`: each POST gets one JSON body instead of an
 *    SSE stream. The API Gateway proxy in front buffers responses anyway,
 *    and none of our tools stream partial results, so SSE would add moving
 *    parts for nothing.
 *
 *  - GET (SSE reconnect) and DELETE (session teardown) return 405: with no
 *    sessions there is nothing to resume or tear down. The spec explicitly
 *    allows this.
 *
 *  - Auth: the MCP spec's remote auth story is OAuth, but for a single-user
 *    personal deployment a static bearer token is proportionate. The check
 *    FAILS CLOSED in Lambda: if MCP_AUTH_TOKEN is somehow unset there, we
 *    500 rather than serve the league to the open internet. Locally (no
 *    token configured) it stays open for Inspector convenience.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./build-server.ts";

function jsonError(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

export async function handleMcpHttp(req: Request): Promise<Response> {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected && process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return jsonError(500, "Server misconfigured: MCP_AUTH_TOKEN is not set.");
  }
  if (expected && req.headers.get("authorization") !== `Bearer ${expected}`) {
    return jsonError(401, "Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>.");
  }
  if (req.method !== "POST") {
    return jsonError(
      405,
      "Method not allowed: this server is stateless — POST JSON-RPC messages only.",
      { allow: "POST" },
    );
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    // Buffer the body so closing the server below can't cut it off.
    // (JSON mode means bodies are small and complete; 202s are empty.)
    const body = await res.text();
    return new Response(body || null, { status: res.status, headers: res.headers });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
