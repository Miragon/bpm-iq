// Publish-boundary build ONLY (the workspace itself runs the raw .ts via Node
// type stripping — see tsconfig.base.json). `pnpm --filter @bpmiq/validator build`
// emits dist/validate.js for npm; dev bin/exports keep pointing at src/validate.ts.
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/validate.ts"],
  format: "esm",
  platform: "node",
  // "type": "module" package — emit dist/validate.js, not .mjs
  fixedExtension: false,
  // no consumers import types from the CLI — ship runtime JS only
  dts: false,
  // @bpmiq/notations is workspace-only (never published) — inline it into the
  // bundle; every other dependency stays external and installs from npm.
  deps: { alwaysBundle: [/^@bpmiq\/notations/] },
});
