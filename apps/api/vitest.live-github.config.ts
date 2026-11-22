import { defineConfig } from "vitest/config";
import { sharedTestOptions, testAlias } from "./vitest.config";

// Opt-in GitHub tests. Source-update writes require a dedicated private scratch repository.
export default defineConfig({
  resolve: { alias: testAlias },
  test: {
    ...sharedTestOptions,
    include: ["test/live/*.live.test.ts"],
    hookTimeout: 300_000,
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
