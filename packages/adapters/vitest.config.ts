import { defineConfig } from "vitest/config";

/**
 * A few adapter tests construct a real platform / runtime rather than a mock, so
 * they do actual work (module graph, path detection, host probes). That's ~1.5s
 * idle but several seconds when `turbo run test` has every package's suite
 * competing for the same cores — over vitest's 5s default, which made the suite
 * green in isolation and red in CI (seen on platform-local-edge.test.ts).
 *
 * A ceiling that reflects "stand up a platform" makes a loaded machine slow
 * rather than red; it only bites when something genuinely hangs. Individual
 * assertions are unaffected.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
