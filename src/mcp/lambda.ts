/**
 * MUFF-39 — AWS Lambda adapter: proxy event ⇄ web-standard Request/Response.
 *
 * API Gateway (HTTP API, payload v2.0) invokes the handler with a JSON
 * event, not an HTTP request object; Lambda Function URLs emit the same
 * shape, so this adapter works behind either front door. It only
 * translates shapes — all MCP behavior lives in http.ts (shared with the
 * local HTTP script, so what you test locally is what runs here).
 */

import { Buffer } from "node:buffer";
import { handleMcpHttp } from "./http.ts";

interface HttpProxyEventV2 {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: { http: { method: string }; domainName: string };
}

interface HttpProxyResultV2 {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: HttpProxyEventV2): Promise<HttpProxyResultV2> {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }

  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;

  const response = await handleMcpHttp(
    new Request(url, { method: event.requestContext.http.method, headers, body }),
  );

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: await response.text(),
  };
}
