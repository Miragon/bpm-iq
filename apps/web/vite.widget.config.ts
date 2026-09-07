import { renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { type Alias, defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

import type { MiragonRendererSpec } from "./src/notations/miragon/spec.ts";

/**
 * The one MCP-App widget build shape: ONE self-contained HTML file (scripts,
 * CSS and the notation icon font inlined) that the Live Host serves as a
 * ui:// resource (apps/live-host/src/http/mcp.ts). Each widget is a separate
 * build against this factory (scripts/build-widgets.ts runs them all) — the
 * iframe sandbox allows no external requests, so nothing may be shared
 * between the emitted files. Runs AFTER the SPA build (emptyOutDir: false) —
 * `pnpm --filter @bpmiq/web build` produces all bundles. Deliberately no
 * react/tailwind: widgets are vanilla TS + one engine each (bpmn-js, dmn-js,
 * a Miragon renderer). Exactly ONE engine per emitted file is also the
 * widgets' whole CSS scoping — the SPA's postcss vendor-CSS scoping is
 * deliberately absent here.
 */
export const widgetConfig = (htmlFile: string, opts: { alias?: Alias[]; emitAs?: string } = {}) =>
  defineConfig({
    plugins: [viteSingleFile(), ...(opts.emitAs ? [emitHtmlAs(htmlFile, opts.emitAs)] : [])],
    resolve: {
      // the shared browser modules under src/lib import via "@/lib/…"
      alias: [...(opts.alias ?? []), { find: "@", replacement: here("./src") }],
    },
    // public/ belongs to the SPA build; a widget carries everything inline
    publicDir: false,
    build: {
      rollupOptions: { input: here(`./${htmlFile}`) },
      outDir: "dist",
      emptyOutDir: false,
      // the icon font must ride inline — any asset below this always inlines
      assetsInlineLimit: 1_000_000,
      chunkSizeWarningLimit: 2_000,
    },
  });

/** the build-time seam every Miragon widget imports its renderer spec through
 *  (src/mcp-app/miragon-main.ts; declared for tsc in src/mcp-app/widget-spec.d.ts) */
export const WIDGET_SPEC_ALIAS = "@/mcp-app/widget-spec";
/** the ONE HTML template of the Miragon widgets */
export const MIRAGON_WIDGET_HTML = "mcp-app-miragon.html";

/**
 * A Miragon-renderer widget: the shared template + entry, the spec aliased in
 * statically (so exactly ONE renderer is inlined), emitted under the file
 * name the Live Host's widget registry expects (`mcp-app-<notation>.html`).
 */
export const miragonWidgetConfig = (spec: MiragonRendererSpec) =>
  widgetConfig(MIRAGON_WIDGET_HTML, {
    // the spec file is named after the id (src/notations/miragon/index.ts)
    alias: [{ find: WIDGET_SPEC_ALIAS, replacement: here(`./src/notations/miragon/${spec.id}.ts`) }],
    emitAs: `mcp-app-${spec.id}.html`,
  });

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** rename the emitted HTML once everything is written — the template's name
 *  is fixed by its input path, the bundle's by the widget registry */
const emitHtmlAs = (from: string, to: string): Plugin => ({
  name: "bpmiq:widget-html-name",
  writeBundle(options) {
    const dir = options.dir ?? "dist";
    renameSync(join(dir, from), join(dir, to));
  },
});
