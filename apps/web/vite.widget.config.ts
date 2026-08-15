import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The one MCP-App widget build shape: ONE self-contained HTML file (scripts,
 * CSS and the notation icon font inlined) that the Live Host serves as a
 * ui:// resource (apps/live-host/src/http/mcp.ts). Each widget is a separate
 * build against this factory — the iframe sandbox allows no external
 * requests, so nothing may be shared between the emitted files. Runs AFTER
 * the SPA build (emptyOutDir: false) — `pnpm --filter @bpmiq/web build`
 * produces all bundles. Deliberately no react/tailwind: widgets are vanilla
 * TS + bpmn-js/dmn-js.
 */
export const widgetConfig = (htmlFile: string) =>
  defineConfig({
    plugins: [viteSingleFile()],
    resolve: {
      // the shared browser modules under src/lib import via "@/lib/…"
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    build: {
      rollupOptions: { input: fileURLToPath(new URL(`./${htmlFile}`, import.meta.url)) },
      outDir: "dist",
      emptyOutDir: false,
      // the icon font must ride inline — any asset below this always inlines
      assetsInlineLimit: 1_000_000,
      chunkSizeWarningLimit: 2_000,
    },
  });
