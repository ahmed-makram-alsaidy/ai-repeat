import { defineConfig } from "vitest/config";

// Heavy E2E suite: real processes, real Chromium, real network.
// Run explicitly: npx vitest run --config vitest.e2e.config.ts
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    exclude: ["**/node_modules/**", "**/restart.manual.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    maxConcurrency: 1,
  },
});
