import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import prefixSelector from "postcss-prefix-selector";
import { defineConfig } from "vite";

import { MIRAGON_RENDERERS, type MiragonRendererSpec } from "./src/notations/miragon/index.ts";

/**
 * The Miragon renderer stylesheets restyle GLOBAL diagram-js classes
 * (.djs-palette etc.) — loaded once via a lazy editor chunk they would
 * permanently re-theme the bpmn-js/dmn-js editors of the same session. Scope
 * them to their canvas hosts at build time; :root stays global (the custom
 * properties are namespaced --wardley-… and --cd-… and collide with nothing;
 * the event-storming sheet sets diagram-js' own --color-… tokens on
 * .djs-parent, which the prefix scopes like any other rule).
 *
 * Each renderer also adds its own root class (`vendorRoot`) to the SAME
 * element that carries the scope class, so a descendant prefix would never
 * match those selectors — they get the scope as a compound instead
 * (.wardley-canvas.wardley-container …). Package, host class and root class
 * come from the renderer spec — one row per registered renderer, nothing to
 * add here for a new one.
 */
const scopeVendorCss = (spec: MiragonRendererSpec) => {
  const prefix = `.${spec.canvasClassName}`;
  const vendorRoot = `.${spec.vendorRoot}`;
  return prefixSelector({
    prefix,
    includeFiles: [vendorSheetOf(spec.pkg)],
    transform: (scope: string, selector: string, prefixed: string) => {
      if (selector.startsWith(":root")) return selector;
      const rest = selector.slice(vendorRoot.length);
      if (selector.startsWith(vendorRoot) && /^($|[ .:,>~+[])/.test(rest)) return scope + selector;
      return prefixed;
    },
  });
};

/** the package's files under node_modules — pnpm's store spells the scope
 *  separator as "+" (node_modules/.pnpm/@miragon+wardley-renderer@…) */
const vendorSheetOf = (pkg: string): RegExp =>
  new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("/", "[/+]"));

// API + OAuth routes proxy to the live host, so cookies stay same-origin in
// dev exactly like in production (where the live host serves this app itself).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: {
      plugins: MIRAGON_RENDERERS.map(scopeVendorCss),
    },
  },
  resolve: {
    alias: [
      // the dev preview of the Miragon widgets (`/mcp-app-miragon.html?notation=<id>`)
      // — the production bundles alias this to ONE spec each (vite.widget.config.ts)
      {
        find: "@/mcp-app/widget-spec",
        replacement: fileURLToPath(new URL("./src/mcp-app/widget-spec.dev.ts", import.meta.url)),
      },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  server: {
    proxy: {
      "/api": "http://localhost:8301",
      "/auth": "http://localhost:8301",
      "/setup": "http://localhost:8301",
      "/webhook": "http://localhost:8301",
      "/healthz": "http://localhost:8301",
    },
  },
});
