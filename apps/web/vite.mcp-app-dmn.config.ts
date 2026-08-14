import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The DECISION widget build — the dmn-js sibling of vite.mcp-app.config.ts:
// ONE self-contained HTML file (scripts, CSS and the dmn font inlined) that the
// Live Host serves as the ui:// resource for `open_decision_modeler`
// (apps/live-host/src/http/mcp.ts). A separate build (and a separate config)
// because each widget must be a single file with nothing shared between them —
// the iframe sandbox allows no external requests.
export default defineConfig({
  plugins: [viteSingleFile()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    rollupOptions: { input: fileURLToPath(new URL("./mcp-app-dmn.html", import.meta.url)) },
    outDir: "dist",
    emptyOutDir: false,
    // the dmn font must ride inline — any asset below this always inlines
    assetsInlineLimit: 1_000_000,
    chunkSizeWarningLimit: 2_000,
  },
});
