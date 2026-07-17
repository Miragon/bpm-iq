#!/usr/bin/env node
/**
 * bpm-mcp-server — HTTP entry point (remote use, e.g. fly.io).
 *
 *   POST /mcp     → the MCP server over Streamable HTTP (stateless; same
 *                   read-only tools as the local stdio server — see tools.ts)
 *   GET  /healthz → liveness for the platform's health checks
 *
 * Optional auth: set MCP_TOKEN and clients must send "Authorization: Bearer <token>"
 * for /mcp.
 *
 * Run: node packages/mcp/http.ts   (PORT defaults to 8080)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer, DEFAULT_ROOT, todosConfigFromEnv } from "./tools.ts";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.MCP_TOKEN;
// list_todos is strictly opt-in (BPM_TODOS_REPO + BPM_TODOS_TOKEN) — without
// both env vars the tool does not exist and the server stays zero-auth
const TODOS = todosConfigFromEnv(process.env);

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Stateless Streamable HTTP: one fresh server + transport per request (read-only tools, no session state). */
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Stateless server: POST JSON-RPC messages to this endpoint." },
        id: null,
      }),
    );
    return;
  }
  const server = createMcpServer(DEFAULT_ROOT, TODOS);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    const body = await readBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      send(
        res,
        400,
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null }),
        "application/json",
      );
    }
  }
}

createServer(async (req, res) => {
  // a single unhandled throw in an async handler would take the whole process
  // down — this endpoint is public, so fail per-request
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    return send(res, 404, "Not found");
  } catch (e) {
    console.error(`request failed: ${(e as Error).message}`);
    if (!res.headersSent) send(res, 500, "Internal error");
    else res.end();
  }
}).listen(PORT, () => {
  console.log(`bpm MCP listening on :${PORT} — POST /mcp${TOKEN ? " (bearer-token protected)" : ""}`);
});
