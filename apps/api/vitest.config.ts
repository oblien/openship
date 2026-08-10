import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Resolve the app's own `@/*` → `src/*` alias (from tsconfig) so tests can
// import modules whose transitive imports use it (e.g. lib/ssh-manager →
// @/lib/system-debug).
export const testAlias = {
  "@": resolve(__dirname, "src"),
};

/** Shared by this config and vitest.e2e.config.ts — keep them in step. */
export const sharedTestOptions = {
  // This suite has a heavy transform graph (cold import can take tens of
  // seconds); a 5s per-test default makes tests that trigger a first-time
  // dynamic import flaky under full-suite contention. Give real headroom.
  testTimeout: 20000,
  // Satisfy config/env.ts's eager boot guard (INTERNAL_TOKEN is required when
  // DEPLOY_MODE !== "desktop") for every suite that transitively imports it.
  // This applies ONLY under vitest — production still requires a real token.
  // Deliberately NOT setting DEPLOY_MODE: leaving its "docker" default keeps
  // auth-mode/zero-auth behaviour unchanged (see test/modules/mail/_setup-env.ts).
  env: {
    INTERNAL_TOKEN: "test-internal-token-0000000000000000000000000000",
  },
};

export default defineConfig({
  resolve: {
    alias: testAlias,
  },
  test: {
    ...sharedTestOptions,
    // test/e2e/** drives a REAL Docker daemon and has minutes-long hooks; it
    // runs only via `bun run test:e2e`. Collecting it here is how it came to
    // report skipped-and-green on every box whose daemon socket isn't at the
    // default path — a passing `bun run test` said nothing about rollback.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
  },
});
