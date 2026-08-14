/**
 * Stateless Streamable-HTTP mount: one fresh McpServer + transport per
 * request, torn down on response close — the pattern both bpmiq MCP servers
 * carried as private copies (one of them had lost the `else res.end()` that
 * keeps a mid-stream failure from hanging the socket).
 *
 * The caller has already authenticated and answered non-POST; this only reads
 * the body (hard-capped — the DoS guard lives in http-kit's readBody), wires
 * the transport and maps a parse/connect failure to the -32700 envelope.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { readBody, send } from "@bpmiq/http-kit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function mountStatelessMcp(
  req: IncomingMessage,
  res: ServerResponse,
  server: McpServer,
  opts: { maxBytes: number },
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    const raw = (await readBody(req, { maxBytes: opts.maxBytes })).toString();
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null });
    } else {
      res.end();
    }
  }
}
