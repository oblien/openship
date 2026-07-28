import { defineConfig } from "vitest/config";

/**
 * The repo tests run against a real (in-memory) PGlite, and each file migrates
 * one from scratch in a setup hook. That's ~1s idle, but several seconds when
 * `turbo run test` has every package's suite competing for the same cores —
 * enough to blow vitest's default 10s hook timeout and fail a suite that is
 * otherwise green (seen on webhook-delivery.repo.test.ts in CI).
 *
 * Give setup hooks and tests a budget that reflects "spin up a database", so a
 * loaded machine is slow rather than red. Individual assertions are still fast;
 * this ceiling only bites when something genuinely hangs.
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
