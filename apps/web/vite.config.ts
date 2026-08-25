import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import prefixSelector from "postcss-prefix-selector";
import { defineConfig } from "vite";

/**
 * The Miragon renderer stylesheets restyle GLOBAL diagram-js classes
 * (.djs-palette etc.) — loaded once via a lazy editor chunk they would
 * permanently re-theme the bpmn-js/dmn-js editors of the same session. Scope
 * them to their canvas hosts at build time; :root stays global (the custom
 * properties are namespaced --wardley-… and --cd-… and collide with nothing).
 */
const scopeVendorCss = (file: RegExp, scope: string) =>
  prefixSelector({
    prefix: scope,
    includeFiles: [file],
    transform: (prefix: string, selector: string, prefixed: string) =>
      selector.startsWith(":root") ? selector : prefixed,
  });

// API + OAuth routes proxy to the live host, so cookies stay same-origin in
// dev exactly like in production (where the live host serves this app itself).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: {
      plugins: [
        scopeVendorCss(/@miragon[/+]wardley-renderer/, ".wardley-canvas"),
        scopeVendorCss(/@miragon[/+]team-topologies-renderer/, ".tt-canvas"),
      ],
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
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
