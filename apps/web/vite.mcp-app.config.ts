import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The MCP-App widget build: ONE self-contained HTML file (scripts, CSS and the
// bpmn font inlined) that the Live Host serves as the ui:// resource for the
// open_modeler tool (apps/live-host/src/http/mcp.ts). Runs AFTER the SPA build
// (emptyOutDir: false) — `pnpm --filter @bpmiq/web build` produces both.
// Deliberately no react/tailwind here: the widget is vanilla TS + bpmn-js, the
// iframe sandbox allows no external requests, so everything must be inline.
export default defineConfig({
  plugins: [viteSingleFile()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    rollupOptions: { input: fileURLToPath(new URL("./mcp-app.html", import.meta.url)) },
    outDir: "dist",
    emptyOutDir: false,
    // the bpmn font must ride inline — any asset below this always inlines
    assetsInlineLimit: 1_000_000,
    chunkSizeWarningLimit: 2_000,
  },
});
