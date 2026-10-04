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
 * `E2E_SCOPE` splits the suite by cost — unset (the local default)
 * runs everything.
 *
 * `heavy` runs the image-building suites (rollback/rebuild and the production
 * control-plane isolation test). `fast` excludes these and scaling, so cold
 * image builds do not delay its sequential tests. Set from the workflow rather
 * than package.json to keep one cross-platform entry point.
 */
const HEAVY = [
  "test/e2e/rollback-build-restore.e2e.test.ts",
  // Builds the production API image and a separate SSH/Docker target.
  "test/e2e/remote-only-control-plane.e2e.test.ts",
];
// Three real K3s nodes, registry and Edge; has its own CI/release job.
const SCALING = "test/e2e/scaling-*.e2e.test.ts";
const SCALING_JOURNEYS = {
  "scaling-application": "test/e2e/scaling-full-cycle.e2e.test.ts",
  "scaling-storage": "test/e2e/scaling-stateful.e2e.test.ts",
  "scaling-databases": "test/e2e/scaling-databases.e2e.test.ts",
} as const;
/**
 * `update` is its own scope because it needs things a checkout does not have: the
 * PREVIOUS release's published images, and an api image for the new side. CI runs it
 * between `build-images` and `merge-images` in docker-images.yml, where the new image
 * exists as a pushed digest — so it is excluded from every other scope, INCLUDING the
 * local default, rather than silently pulling a release on someone's laptop.
 */
const UPDATE = "test/e2e/update-from-previous-release.e2e.test.ts";
const scope = process.env.E2E_SCOPE;
if (
  scope &&
  !["fast", "heavy", "update", "scaling", ...Object.keys(SCALING_JOURNEYS)].includes(scope)
)
  throw new Error(`Unknown E2E_SCOPE: ${scope}`);
const include =
  scope === "heavy"
    ? HEAVY
    : scope === "update"
      ? [UPDATE]
      : scope === "scaling"
        ? [SCALING]
        : scope && scope in SCALING_JOURNEYS
          ? [SCALING_JOURNEYS[scope as keyof typeof SCALING_JOURNEYS]]
          : ["test/e2e/**/*.e2e.test.ts"];

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
      ...(scope === "fast" ? [...HEAVY, SCALING] : []),
      // Opt-in only: `E2E_SCOPE=update` is the sole way to run it (see UPDATE above).
      ...(scope === "update" ? [] : [UPDATE]),
    ],
    // Pulling and building images and streaming volumes all happen in
    // beforeAll. There is no sane default here, which is why every E2E hook
    // currently passes its own timeout inline.
    hookTimeout: 300_000,
    testTimeout: 300_000,
    // Scaling steps share the resources created by preceding steps. A failed
    // setup must fail the job immediately, with teardown and diagnostics,
    // instead of running dependent mutations against an incomplete fixture.
    // Independent journeys still run in separate CI matrix jobs.
    bail: scope?.startsWith("scaling") ? 1 : 0,
    // One shared daemon, real containers, real volume names: parallel files
    // race each other on pulls and cleanup.
    fileParallelism: false,
  },
});
