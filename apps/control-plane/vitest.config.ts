import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources via the custom export condition.
// Setting `conditions` replaces Vite's defaults, so the server defaults are restated — minus
// "module", which would select bundler-only ESM builds of dependencies (e.g. @opentelemetry/api).
const conditions = ["@blockforge/source", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["@blockforge/source"] } },
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    // Integration suites share one Postgres database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
