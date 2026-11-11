import { defineConfig } from "vitest/config";
import { sharedTestOptions, testAlias } from "./vitest.config";

// Explicit opt-in: this suite writes only to a private verification repository.
export default defineConfig({
  resolve: { alias: testAlias },
  test: {
    ...sharedTestOptions,
    include: ["test/live/runtime-source.live.test.ts"],
    hookTimeout: 300_000,
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
