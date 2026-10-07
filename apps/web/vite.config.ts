/**
 * apps/web/vite.config.ts
 *
 * Usage: Vite dev server and build config for the customer portal.
 *   pnpm --filter @billdude/web dev     # http://localhost:5173, proxies /api to the API on :4000
 *   pnpm --filter @billdude/web build   # static files in apps/web/dist
 * Set API_PROXY_TARGET to proxy somewhere other than http://localhost:4000.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://localhost:4000" },
  },
});
