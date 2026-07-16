#!/usr/bin/env node
/**
 * bpm-mcp-server — HTTP entry point (remote use, e.g. fly.io).
 *
 * One process, two surfaces:
 *   POST /mcp   → the MCP server over Streamable HTTP (stateless; same read-only
 *                 tools as the local stdio server — see tools.ts)
 *   GET  /*     → the built VitePress portal (.vitepress/dist)
 *   GET  /healthz → liveness for the platform's health checks
 *
 * Optional auth: set MCP_TOKEN and clients must send "Authorization: Bearer <token>"
 * for /mcp. The portal stays public.
 *
 * Run: node packages/mcp/http.ts   (PORT defaults to 8080)
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer, DEFAULT_ROOT, todosConfigFromEnv } from "./tools.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(DEFAULT_ROOT, ".vitepress", "dist");
const TOKEN = process.env.MCP_TOKEN;
// list_todos is strictly opt-in (BPM_TODOS_REPO + BPM_TODOS_TOKEN) — without
// both env vars the tool does not exist and the server stays zero-auth
const TODOS = todosConfigFromEnv(process.env);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

/** Static portal serving with VitePress cleanUrls semantics (/x → x.html, /x/ → x/index.html). */
function serveStatic(urlPath: string, res: ServerResponse): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // malformed percent-encoding (e.g. GET /%) must not throw — this endpoint is public
    send(res, 400, "Bad request");
    return;
  }
  const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    join(DIST, safePath),
    join(DIST, safePath, "index.html"),
    join(DIST, `${safePath.replace(/\/$/, "")}.html`),
  ];
  for (const file of candidates) {
    if (!file.startsWith(DIST)) break; // path traversal guard
    if (existsSync(file) && statSync(file).isFile()) {
      const immutable = file.includes("/assets/");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=60",
      });
      createReadStream(file).pipe(res);
      return;
    }
  }
  const notFound = join(DIST, "404.html");
  if (existsSync(notFound)) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    createReadStream(notFound).pipe(res);
  } else {
    send(res, 404, "Not found");
  }
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
  // a single unhandled throw in an async handler would take the whole
  // portal+MCP process down — this endpoint is public, so fail per-request
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(url.pathname, res);
  } catch (e) {
    console.error(`request failed: ${(e as Error).message}`);
    if (!res.headersSent) send(res, 500, "Internal error");
    else res.end();
  }
}).listen(PORT, () => {
  console.log(
    `bpm portal + MCP listening on :${PORT} — portal: / · MCP: POST /mcp${TOKEN ? " (bearer-token protected)" : ""}`,
  );
  if (!existsSync(DIST))
    console.warn(`WARNING: ${DIST} missing — run 'npm run portal:build' first; only /mcp will work.`);
});
