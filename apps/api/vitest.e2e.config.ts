import { configDefaults, defineConfig } from "vitest/config";
import { sharedTestOptions, testAlias } from "./vitest.config";

/**
 * Real-Docker-daemon suite. Separate from the default config so `bun run test`
 * stays daemon-free and these cases can't pass by being silently skipped.
 *
 * Run with a reachable daemon and RUN_DOCKER_E2E=1:
 *   bun run --cwd apps/api test:e2e
 */

/**
 * `E2E_SCOPE` splits the suite by cost, for CI only — unset (the local default)
 * runs everything.
 *
 * `fast` drops `rollback-build-restore`, which pulls a Node base image and runs a
 * real `docker build`: ~225s cold, and `fileParallelism: false` means it's 225s
 * of the wall clock nobody else can use. `heavy` runs only that file. Set from
 * the workflow rather than from a package.json script, so the scripts stay
 * cross-platform and there is exactly one entry point to run these locally.
 */
const HEAVY = "test/e2e/rollback-build-restore.e2e.test.ts";
const scope = process.env.E2E_SCOPE;
const include = scope === "heavy" ? [HEAVY] : ["test/e2e/**/*.e2e.test.ts"];

export default defineConfig({
  resolve: {
    alias: testAlias,
  },
  test: {
    ...sharedTestOptions,
    include,
    exclude: [...configDefaults.exclude, ...(scope === "fast" ? [HEAVY] : [])],
    // Pulling and building images and streaming volumes all happen in
    // beforeAll. There is no sane default here, which is why every E2E hook
    // currently passes its own timeout inline.
    hookTimeout: 300_000,
    testTimeout: 300_000,
    // One shared daemon, real containers, real volume names: parallel files
    // race each other on pulls and cleanup.
    fileParallelism: false,
  },
});
