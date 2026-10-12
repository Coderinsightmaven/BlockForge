import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import type { ProxyOptions } from "vite";

/** The control plane listens here in development (apps/control-plane). */
const CONTROL_PLANE = "http://127.0.0.1:8080";

const proxy: Record<string, ProxyOptions> = {
  // REST + the realtime WebSocket (/api/v1/realtime) share the /api prefix.
  "/api": { target: CONTROL_PLANE, ws: true, changeOrigin: false },
  "/healthz": { target: CONTROL_PLANE, changeOrigin: false },
  "/readyz": { target: CONTROL_PLANE, changeOrigin: false },
};

export default defineConfig({
  plugins: [
    // Must run before the React plugin so generated route code is transformed.
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: true,
      quoteStyle: "double",
      semicolons: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    // Consume workspace packages from TypeScript source (no prebuild needed).
    conditions: ["@blockforge/source", ...defaultClientConditions],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 900 },
});
