import { tmpdir } from "node:os";
import { join } from "node:path";
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
/**
 * `update` is its own scope because it needs things a checkout does not have: the
 * PREVIOUS release's published images, and an api image for the new side. CI runs it
 * between `build-images` and `merge-images` in docker-images.yml, where the new image
 * exists as a pushed digest — so it is excluded from every other scope, INCLUDING the
 * local default, rather than silently pulling a release on someone's laptop.
 */
const UPDATE = "test/e2e/update-from-previous-release.e2e.test.ts";
const scope = process.env.E2E_SCOPE;
const include =
  scope === "heavy" ? [HEAVY] : scope === "update" ? [UPDATE] : ["test/e2e/**/*.e2e.test.ts"];

/**
 * The sandbox `backup-volume-roundtrip` puts its destination inside, read back
 * from `env.BACKUP_LOCAL_ROOT` by the test rather than recomputed there.
 *
 * A dedicated directory, not `tmpdir()` itself: the root is what the deny-list in
 * local-path.ts screens, and "point it at a dedicated directory" is the advice the
 * product gives an operator — the suite should be configured the way one would be.
 *
 * Per-process, because the suite removes this whole tree when it finishes: a fixed
 * name would let one run delete the sandbox another was mid-backup in.
 */
const BACKUP_ROOT = join(tmpdir(), `openship-e2e-backup-root-${process.pid}`);

export default defineConfig({
  resolve: {
    alias: testAlias,
  },
  test: {
    ...sharedTestOptions,
    include,
    env: {
      ...sharedTestOptions.env,
      // A `kind: 'local'` destination is gated on EVERY path that uses one, not
      // just the ones that create one (local-gate.ts), so the suite has to opt in
      // the way an operator does. It belongs here and not in a hook: config/env.ts
      // parses process.env eagerly at import, which a `beforeAll` runs after.
      BACKUP_ALLOW_LOCAL_DESTINATION: "true",
      BACKUP_LOCAL_ROOT: BACKUP_ROOT,
    },
    exclude: [
      ...configDefaults.exclude,
      ...(scope === "fast" ? [HEAVY] : []),
      // Opt-in only: `E2E_SCOPE=update` is the sole way to run it (see UPDATE above).
      ...(scope === "update" ? [] : [UPDATE]),
    ],
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
