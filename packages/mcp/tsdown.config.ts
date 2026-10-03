// Publish-boundary build ONLY (the workspace itself runs the raw .ts via Node
// type stripping — see tsconfig.base.json). `pnpm --filter @miragon/design-iq-mcp build`
// emits dist/server.js + dist/http.js (tools.ts becomes a shared chunk) for npm;
// dev bin/exports keep pointing at the raw .ts entries.
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["server.ts", "http.ts"],
  format: "esm",
  platform: "node",
  // "type": "module" package — emit dist/server.js + dist/http.js, not .mjs
  fixedExtension: false,
  // no consumers import types from the server — ship runtime JS only
  dts: false,
  // @designiq/notations, @designiq/contracts, @designiq/http-kit and @designiq/mcp-kit are
  // workspace-only (never published) — inline them into the bundle; every
  // other dependency stays external and installs from npm (fast-xml-parser is
  // declared as a dependency here because the inlined notations/extract
  // imports it at runtime; @modelcontextprotocol/node because the inlined
  // mcp-kit/mount does).
  deps: { alwaysBundle: [/^@designiq\/(notations|contracts|http-kit|mcp-kit|github-app)/] },
});
