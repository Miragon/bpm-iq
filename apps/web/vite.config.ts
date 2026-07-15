import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// API + OAuth routes proxy to the live host, so cookies stay same-origin in
// dev exactly like in production (where the live host serves this app itself).
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
