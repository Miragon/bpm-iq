#!/usr/bin/env node
/**
 * designiq-mcp-server — stdio entry point (local use).
 *
 * Claude Code auto-connects via the repo's .mcp.json. Tool definitions live in
 * tools.ts, shared with the HTTP entry point (http.ts) that runs on fly.io.
 *
 * Content repo: `node server.ts --root /path/to/content-repo` or
 * DESIGNIQ_CONTENT_ROOT (the legacy BPM_CONTENT_ROOT is still read; the new // legacy-name-ok
 * name wins) — defaults to the bundled process-documentation example.
 *
 * One command, no build step: node server.ts (Node >= 23.6, built-in type stripping).
 */
import { existsSync } from "node:fs";

import { cliRoot } from "@designiq/notations/cli";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createMcpServer, DEFAULT_ROOT, todosConfigFromEnv } from "./tools.ts";

const root = cliRoot(process.argv.slice(2), { defaultRoot: DEFAULT_ROOT });
if (!existsSync(root)) {
  // fail fast with usage instead of serving an empty repo — the bundled-example
  // fallback only exists inside the monorepo checkout, never in an npm install
  console.error(
    [
      `designiq-mcp-server: content root not found: ${root}`,
      "",
      "Point the server at a content repo (a checkout with a root designiq.yml):",
      "  npx @miragon/design-iq-mcp --root <path-to-content-repo>",
      "  DESIGNIQ_CONTENT_ROOT=<path-to-content-repo> npx @miragon/design-iq-mcp",
      "(the legacy BPM_CONTENT_ROOT is still read; DESIGNIQ_CONTENT_ROOT wins)", // legacy-name-ok: env fallback
    ].join("\n"),
  );
  process.exit(2);
}

// list_todos is strictly opt-in (DESIGNIQ_TODOS_REPO + DESIGNIQ_TODOS_TOKEN, also
// read under the legacy BPM_TODOS_* names) — without a repo AND a token the tool // legacy-name-ok
// does not exist and the server stays zero-auth
const todos = todosConfigFromEnv(process.env);
const server = createMcpServer(root, todos);
await server.connect(new StdioServerTransport());
console.error(
  `designiq-mcp-server ready — read-only tools${todos ? ` (+ list_todos on ${todos.repo})` : ""}, repo root: ${root}`,
);
