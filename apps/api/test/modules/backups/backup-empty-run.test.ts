/**
 * A backup that captured nothing must FAIL.
 *
 * [#611](https://github.com/oblien/openship/issues/611): a policy on the control
 * plane's own `postgres` service finished in two seconds with
 * `status: "succeeded"`, `bytesTransferred: 0`, `artifacts: []`, and an empty
 * destination prefix. The volume producer had found no sources and simply
 * `return`ed, and the orchestrator recorded that as a successful run — so a nightly
 * schedule would have reported green forever while the database holding every
 * project, domain and encrypted secret was not backed up at all.
 *
 * Both shapes are pinned here, because they fail differently:
 *   - no artifacts at all (the reported case);
 *   - artifacts that exist but carry no bytes — which the "no artifacts" check
 *     alone would wave through, and which is what a dump whose command silently
 *     produced nothing looks like.
 *
 * A failed run is strictly safer than a succeeded-empty one: it notifies, and it
 * cannot later be mistaken for a restore point that exists.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Artifacts the fake producer yields. `bytes` IS the payload, so the hasher's
   *  byte count is derived from it rather than declared separately. */
  artifacts: [] as Array<{ name: string; bytes: string }>,
  row: {} as Record<string, unknown>,
  notifications: [] as string[],
  puts: [] as string[],
  deleted: [] as string[],
  /** Make the manifest put fail, to reach the run-level catch with bytes already up. */
  failManifestPut: false,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => ({
        id: "bkr_live",
        status: "queued",
        policyId: "pol_1",
        projectId: "prj_1",
        serviceId: "svc_1",
        mailServerId: null,
        organizationId: "org_1",
      }),
      claimExecution: async () => "claimed",
      acknowledgeExecutionFinished: async () => {},
      transition: async (_id: string, status: string, patch?: Record<string, unknown>) => {
        Object.assign(h.row, { status }, patch ?? {});
      },
    },
    backupPolicy: {
      findById: async () => ({
        id: "pol_1",
        destinationId: "dst_1",
        sourceKind: "service",
        mailServerId: null,
        projectId: "prj_1",
        serviceId: "svc_1",
        payloadKind: "auto",
        preHook: null,
        postHook: null,
        hookTimeoutSeconds: 30,
        payloadConfig: {},
      }),
    },
    backupDestination: {
      findById: async () => ({
        id: "dst_1",
        organizationId: "org_1",
        name: "R2",
        pathPrefix: "openship",
      }),
      setLastVerified: async () => {},
    },
    service: {
      findById: async () => ({
        id: "svc_1",
        projectId: "prj_1",
        name: "postgres",
        image: "postgres:16-alpine",
        environment: null,
        volumes: null,
        namespaceVolumes: false,
        ports: null,
        command: null,
      }),
    },
    project: {
      findById: async () => ({
        id: "prj_1",
        slug: "openship",
        name: "Openship",
        organizationId: "org_1",
        activeDeploymentId: "dep_1",
      }),
      listEnvVars: async () => [],
      // serviceHandleFor reads env through the SCOPED map (project-level and
      // service-scoped, per environment) rather than every row in the project.
      getEnvMap: async () => ({}),
    },
    deployment: { findById: async () => ({ id: "dep_1", meta: {} }) },
  },
}));

vi.mock("@repo/adapters", async () => {
  const { Readable, PassThrough } = await import("node:stream");
  // Pulled from the real (side-effect-free) leaf module rather than restated, so a
  // key added to the canonical set cannot go missing in the mock and silently let a
  // recorded command get credential-scrubbed again.
  const { PRESERVED_ARTIFACT_METADATA_KEYS } =
    await import("../../../../../packages/adapters/src/backup/common/artifact-metadata");
  // Same reason: the REAL sanitizer, from its side-effect-free leaf. A stub that
  // returned the config unchanged would let a compression value the pipeline
  // cannot build reach a producer here and pass, which is the whole thing it
  // exists to stop.
  const { sanitizeProducerOpts } =
    await import("../../../../../packages/adapters/src/backup/common/producer-opts");
  /**
   * Counts the bytes it actually saw and passes them through — the same contract as the
   * real HashingPassthrough.
   *
   * An earlier version swallowed chunks and read the size from a per-test table, which
   * made the "still succeeds when real bytes were captured" case tautological: the size
   * the guard checked was a number the test handed it, not a consequence of the payload.
   * Deriving it from the stream means a guard that over-counted or under-counted would
   * show up here.
   */
  class FakeHasher extends PassThrough {
    private seen = 0;
    summary() {
      return { sha256: "d0", bytesWritten: this.seen };
    }
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
      this.seen += chunk.byteLength;
      cb(null, chunk);
    }
  }
  return {
    HashingPassthrough: FakeHasher,
    PRESERVED_ARTIFACT_METADATA_KEYS,
    sanitizeProducerOpts,
    artifactKey: (_b: unknown, name: string) => `openship/openship/postgres/bkr_live/${name}`,
    manifestKey: () => "openship/openship/postgres/bkr_live/manifest.json",
    runPrefix: () => "openship/openship/postgres/bkr_live",
    buildManifest: () => ({ version: 1 }),
    resolveDestination: () => ({
      preflight: async () => ({ ok: true }),
      // DRAINS the body before resolving, like every real destination does. A `put`
      // that ignored the stream let `hasher.summary()` be read before the pipe had
      // delivered anything, so the byte count depended on scheduling — invisible while
      // the fake hasher returned a hardcoded size, and a false failure the moment it
      // started counting for real.
      put: async (key: string, body: AsyncIterable<Buffer>) => {
        if (h.failManifestPut && key.endsWith("manifest.json")) {
          throw new Error("destination refused the manifest");
        }
        h.puts.push(key);
        for await (const _chunk of body) {
          /* consume to EOF */
        }
        return {};
      },
      deleteMany: async (keys: string[]) => {
        h.deleted.push(...keys);
        return { deleted: keys, failed: [] };
      },
    }),
    resolveExecutor: () => ({ readContainerEnv: async () => ({}) }),
    resolveProducerForService: () => ({
      kind: "volume",
      async *produce() {
        for (const a of h.artifacts) {
          yield {
            name: a.name,
            // The payload is exactly `a.bytes`, so an empty string really is a
            // zero-byte artifact rather than one declared to be zero.
            stream: Readable.from(a.bytes.length > 0 ? [Buffer.from(a.bytes)] : []),
            payloadKind: "volume",
            metadata: {},
          };
        }
      },
    }),
    resolveProducer: () => ({ kind: "volume", async *produce() {} }),
  };
});

vi.mock("../../../src/lib/job-runner", () => ({
  getJobRunner: async () => ({ enqueueRun: async () => {} }),
}));
vi.mock("../../../src/lib/deployment-runtime", () => ({
  disposeRuntime: () => {},
  disposePlatform: () => {},
  resolveDeploymentPlatform: async () => ({ platform: { runtime: { name: "docker" } } }),
  resolveTargetPlatform: async () => ({ runtime: { name: "docker" } }),
}));
vi.mock("../../../src/lib/encryption", () => ({ decryptEnvMap: (v: unknown) => v }));
vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: {
    emit: (e: { eventType: string }) => {
      h.notifications.push(e.eventType);
    },
  },
}));
vi.mock("../../../src/modules/backup-destinations/hydrate-server", () => ({
  toAdapterRow: async (row: unknown) => row,
}));
vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdForService: async () => "c_pg",
  liveContainerForService: async () => ({ containerId: "c_pg", running: true }),
}));

import { BackupOrchestrator } from "../../../src/modules/backups/backup.orchestrator";

beforeEach(() => {
  h.artifacts = [];
  h.row = {};
  h.notifications.length = 0;
  h.puts.length = 0;
  h.deleted.length = 0;
  h.failManifestPut = false;
});

describe("a run that captured nothing is not a successful backup", () => {
  it("fails instead of recording succeeded with zero artifacts", async () => {
    h.artifacts = []; // the producer found nothing — #611's exact shape

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    expect(String(h.row.errorMessage)).toMatch(/captured nothing/i);
    // Named so an operator knows WHICH service and which payload came up empty.
    expect(String(h.row.errorMessage)).toContain("postgres");
    expect(String(h.row.errorMessage)).toContain("volume");
    expect(h.notifications).not.toContain("backup_run.succeeded");
  });

  it("does not write a manifest for a run that captured nothing", async () => {
    // A manifest is what restore keys "is this run complete" off. Writing one over
    // an empty run is how the destination ends up holding a pointer to nothing.
    h.artifacts = [];

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.puts).toEqual([]);
  });

  it("fails when an artifact exists but carries no bytes", async () => {
    // The check that "no artifacts" alone would miss: a dump command that exits
    // clean having written nothing still yields an artifact record.
    h.artifacts = [{ name: "volume-pgdata.tar.zst", bytes: "" }];

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    expect(String(h.row.errorMessage)).toMatch(/0 bytes/);
    expect(String(h.row.errorMessage)).toContain("volume-pgdata.tar.zst");
  });

  it("still succeeds — and writes its manifest — when real bytes were captured", async () => {
    // The guard must not be so eager that it fails an honest backup.
    h.artifacts = [{ name: "volume-pgdata.tar.zst", bytes: "x".repeat(4096) }];

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("succeeded");
    // Derived from the payload the producer actually yielded, not from a fixture knob.
    expect(h.row.bytesTransferred).toBe(4096);
    expect(h.puts).toContain("openship/openship/postgres/bkr_live/manifest.json");
    expect(h.notifications).toContain("backup_run.succeeded");
  });

  it("reclaims what it already uploaded when a later artifact is empty", async () => {
    // Retention only prunes SUCCEEDED runs, so a failed run's uploads are orphaned at
    // the destination permanently — unrestorable (no manifest) and never collected.
    // A policy in this shape runs nightly, so the leak would be per-run and forever.
    h.artifacts = [
      { name: "volume-data.tar.zst", bytes: "x".repeat(2048) },
      { name: "volume-empty.tar.zst", bytes: "" },
    ];

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    expect(h.deleted).toEqual([
      "openship/openship/postgres/bkr_live/volume-data.tar.zst",
      "openship/openship/postgres/bkr_live/volume-empty.tar.zst",
    ]);
  });

  it("reclaims from the run-level failure path, not just the empty-capture branch", async () => {
    // The reclaim lives in ONE place — the run-level catch — so a failure that is nothing
    // to do with emptiness still cleans up after itself. Here the destination rejects the
    // manifest after a real artifact has already landed; without a central reclaim that
    // artifact is orphaned forever, because retention skips non-succeeded runs.
    h.artifacts = [{ name: "volume-data.tar.zst", bytes: "x".repeat(1024) }];
    h.failManifestPut = true;

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    expect(h.deleted).toContain("openship/openship/postgres/bkr_live/volume-data.tar.zst");
  });
});
