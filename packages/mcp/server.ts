#!/usr/bin/env node
/**
 * bpm-mcp-server — stdio entry point (local use).
 *
 * Claude Code auto-connects via the repo's .mcp.json. Tool definitions live in
 * tools.ts, shared with the HTTP entry point (http.ts) that runs on fly.io.
 *
 * Content repo: `node server.ts --root /path/to/content-repo` or
 * BPM_CONTENT_ROOT — defaults to the bundled process-documentation example.
 *
 * One command, no build step: node server.ts (Node >= 23.6, built-in type stripping).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer, DEFAULT_ROOT } from "./tools.ts";

const rootFlag = process.argv.indexOf("--root");
const rootArg = rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && !rootArg) {
  console.error("--root requires a directory argument");
  process.exit(2);
}
const root = rootArg ? resolve(rootArg) : DEFAULT_ROOT;
if (!existsSync(root)) {
  // fail fast with usage instead of serving an empty repo — the bundled-example
  // fallback only exists inside the monorepo checkout, never in an npm install
  console.error(
    [
      `bpm-mcp-server: content root not found: ${root}`,
      "",
      "Point the server at a BPM content repo (a checkout with processes/ + landscape/):",
      "  bpmiq-mcp --root <path-to-content-repo>",
      "  BPM_CONTENT_ROOT=<path-to-content-repo> bpmiq-mcp",
    ].join("\n"),
  );
  process.exit(2);
}

const server = createMcpServer(root);
await server.connect(new StdioServerTransport());
console.error(`bpm-mcp-server ready — read-only tools, repo root: ${root}`);
