import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources via the custom export condition. Tests
// run in Vite's SSR environment, so the condition must be set there too (setting `conditions`
// replaces Vite's defaults, hence "node" is restated).
const conditions = ["@blockforge/source", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["@blockforge/source"] } },
  test: { include: ["test/**/*.test.ts"] },
});
