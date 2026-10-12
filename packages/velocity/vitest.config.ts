import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@blockforge/source"] },
  test: { include: ["test/**/*.test.ts"] },
});
