// Publish-boundary build ONLY (the workspace itself runs the raw .ts via Node
// type stripping — see tsconfig.base.json). `pnpm --filter @bpmiq/mcp build`
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
  // @bpmiq/notations and @bpmiq/contracts are workspace-only (never published) —
  // inline them into the bundle; every other dependency stays external and
  // installs from npm (fast-xml-parser is declared as a dependency here because
  // the inlined notations/extract imports it at runtime; contracts is zero-dep).
  deps: { alwaysBundle: [/^@bpmiq\/(notations|contracts)/] },
});
