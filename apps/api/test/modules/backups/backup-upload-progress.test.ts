/**
 * Live upload progress + the uploading heartbeat.
 *
 * A single-artifact pg_dump streams the whole payload through ONE
 * `destination.put`, and the run row used to sit (uploading, bytes=NULL,
 * lastEventAt=frozen) for the entire transfer — indistinguishable from a
 * wedge, which is why the idle sweep had to leave `uploading` alone (#516).
 *
 * This pins the fix:
 *   - the upload stream reports cumulative bytes MID-artifact;
 *   - progress is aggregated across artifacts, never reset per file;
 *   - persistence is throttled (a chunk storm is not a write storm) and every
 *     persisted value rides out on the existing SSE `progress` event;
 *   - the repo write is monotonic and accepts only `uploading`, so a late
 *     update can neither rewind the counter nor mutate another state;
 *   - the terminal write still records the exact uploaded total;
 *   - a failed run is not followed by late progress writes.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import { createBackupRunRepo } from "../../../../../packages/db/src/repos/backup.repo";

const h = vi.hoisted(() => ({
  /** Artifacts the fake producer yields; `chunks` ARE the payload. */
  artifacts: [] as Array<{ name: string; chunks: number[] }>,
  row: {} as Record<string, unknown>,
  notifications: [] as string[],
  puts: [] as string[],
  deleted: [] as string[],
  /** Every throttled progress write that reached the repo, in order. */
  progressWrites: [] as number[],
  /** Every mutation of row.bytesTransferred, in order (monotonicity proof). */
  bytesHistory: [] as number[],
  /** Write-order log so "no late write after terminal" is checkable. */
  writeLog: [] as string[],
  failPutFor: null as string | null,
  rejectProgress: false,
  finalizeAfterPutAs: null as "succeeded" | "server_error" | null,
  progressResponseGate: null as Promise<void> | null,
  releaseProgressResponse: null as (() => void) | null,
  progressWriteStarted: null as (() => void) | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => ({
        id: "bkr_live",
        status: typeof h.row.status === "string" ? h.row.status : "queued",
        policyId: "pol_1",
        serviceId: "svc_1",
        mailServerId: null,
        organizationId: "org_1",
      }),
      transition: async (_id: string, status: string, patch?: Record<string, unknown>) => {
        if (["succeeded", "failed", "cancelled", "server_error"].includes(String(h.row.status))) {
          return false;
        }
        h.writeLog.push(`transition:${status}`);
        Object.assign(h.row, { status }, patch ?? {});
        if (typeof patch?.bytesTransferred === "number") {
          h.bytesHistory.push(patch.bytesTransferred);
        }
        return true;
      },
      // Mirrors the real repo method's two guards: only `uploading` accepts the
      // write, and a value that does not advance the counter is refused.
      recordUploadProgress: async (_id: string, bytes: number) => {
        if (h.rejectProgress || h.row.status !== "uploading") return false;
        if (typeof h.row.bytesTransferred === "number" && h.row.bytesTransferred >= bytes) {
          return false;
        }
        h.writeLog.push(`progress:${bytes}`);
        h.progressWrites.push(bytes);
        h.bytesHistory.push(bytes);
        Object.assign(h.row, { bytesTransferred: bytes, lastEventAt: new Date() });
        h.progressWriteStarted?.();
        await h.progressResponseGate;
        return true;
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
      getEnvMap: async () => ({}),
    },
    deployment: { findById: async () => ({ id: "dep_1", meta: {} }) },
  },
}));

vi.mock("@repo/adapters", async () => {
  const { Readable, PassThrough } = await import("node:stream");
  const { PRESERVED_ARTIFACT_METADATA_KEYS } =
    await import("../../../../../packages/adapters/src/backup/common/artifact-metadata");
  const { sanitizeProducerOpts } =
    await import("../../../../../packages/adapters/src/backup/common/producer-opts");
  /**
   * Same contract as the real HashingPassthrough — counts the bytes it saw —
   * plus the onBytes callback under test, fired per chunk with the cumulative
   * count, exactly like the real one.
   */
  class FakeHasher extends PassThrough {
    private seen = 0;
    private readonly onBytes?: (bytesWritten: number) => void;
    constructor(opts?: { onBytes?: (bytesWritten: number) => void }) {
      super();
      this.onBytes = opts?.onBytes;
    }
    summary() {
      return { sha256: "d0", bytesWritten: this.seen };
    }
    override _transform(
      chunk: Buffer,
      _enc: BufferEncoding,
      cb: (e?: Error | null, data?: unknown) => void,
    ) {
      this.seen += chunk.byteLength;
      this.onBytes?.(this.seen);
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
      put: async (key: string, body: AsyncIterable<Buffer>) => {
        h.puts.push(key);
        for await (const _chunk of body) {
          if (h.failPutFor && key.endsWith(h.failPutFor)) {
            throw new Error("destination connection dropped mid-artifact");
          }
        }
        if (h.finalizeAfterPutAs) {
          const status = h.finalizeAfterPutAs;
          h.finalizeAfterPutAs = null;
          Object.assign(h.row, { status, finishedAt: new Date() });
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
            stream: Readable.from(a.chunks.map((n) => Buffer.alloc(n))),
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
import { backupRunBus } from "../../../src/modules/backups/backup.sse";

beforeEach(() => {
  h.artifacts = [];
  h.row = {};
  h.notifications.length = 0;
  h.puts.length = 0;
  h.deleted.length = 0;
  h.progressWrites.length = 0;
  h.bytesHistory.length = 0;
  h.writeLog.length = 0;
  h.failPutFor = null;
  h.rejectProgress = false;
  h.finalizeAfterPutAs = null;
  h.progressResponseGate = null;
  h.releaseProgressResponse = null;
  h.progressWriteStarted = null;
});

describe("live upload progress", () => {
  it("reports cumulative bytes mid-artifact, throttled, and finishes exact", async () => {
    // Two artifacts, several chunks each. The whole run completes in under the
    // one-second persist interval, so exactly ONE throttled write may land —
    // the first chunk of the first artifact (lastWriteAt starts at 0).
    h.artifacts = [
      { name: "volume-pgdata.tar.zst", chunks: [100, 100, 100] },
      { name: "volume-wal.tar.zst", chunks: [50, 50] },
    ];
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = backupRunBus.subscribe("bkr_live", (e) =>
      events.push(e as Record<string, unknown>),
    );

    try {
      await new BackupOrchestrator().execute("bkr_live");
    } finally {
      unsubscribe();
    }

    expect(h.row.status).toBe("succeeded");
    // The terminal value is the exact uploaded total, not a throttled estimate.
    expect(h.row.bytesTransferred).toBe(400);

    // Throttled: six chunks, ONE progress write.
    expect(h.progressWrites).toEqual([100]);

    // The persisted value went out on the existing SSE progress channel.
    const progressEvents = events.filter((e) => e.type === "progress");
    expect(progressEvents).toEqual([
      { type: "progress", bytesTransferred: 100, currentArtifact: "volume-pgdata.tar.zst" },
    ]);

    // Never backward: progress write → per-artifact transitions → terminal.
    const increasing = h.bytesHistory.every((v, i) => i === 0 || v >= h.bytesHistory[i - 1]);
    expect(increasing).toBe(true);
    expect(h.bytesHistory).toContain(300); // artifact boundary, cumulative
  });

  it("leaves no pending progress write behind a failed run", async () => {
    h.artifacts = [
      { name: "volume-pgdata.tar.zst", chunks: [100, 100] },
      { name: "volume-wal.tar.zst", chunks: [50] },
    ];
    h.failPutFor = "volume-wal.tar.zst";

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    // A failed run advertises nothing (its objects were reclaimed).
    expect(h.row.bytesTransferred).toBe(0);
    // The failed transition is the LAST write — no throttled progress landed
    // after it (the repo's terminal guard refuses any that try).
    expect(h.writeLog[h.writeLog.length - 1]).toBe("transition:failed");
  });

  it("coalesces behind a delayed write and settles before the artifact boundary", async () => {
    const runId = "bkr_delayed_progress";
    h.artifacts = [{ name: "volume-pgdata.tar.zst", chunks: [100, 100, 100] }];
    h.progressResponseGate = new Promise<void>((resolve) => {
      h.releaseProgressResponse = resolve;
    });
    const progressStarted = new Promise<void>((resolve) => {
      h.progressWriteStarted = resolve;
    });
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_100)
      .mockReturnValueOnce(3_200);
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = backupRunBus.subscribe(runId, (event) =>
      events.push(event as Record<string, unknown>),
    );

    const execution = new BackupOrchestrator().execute(runId);
    try {
      await progressStarted;
      // The database has accepted the estimate, but its promise has not returned.
      // Later samples coalesce behind it and the artifact boundary must wait.
      expect(h.progressWrites).toEqual([100]);
      expect(h.writeLog).not.toContain("transition:succeeded");
      h.releaseProgressResponse?.();
      await execution;
    } finally {
      h.releaseProgressResponse?.();
      await execution.catch(() => {});
      unsubscribe();
      now.mockRestore();
    }

    const liveBytes = events.flatMap((event) =>
      typeof event.bytesTransferred === "number" ? [event.bytesTransferred] : [],
    );
    expect(liveBytes.every((value, index) => index === 0 || value >= liveBytes[index - 1])).toBe(
      true,
    );
    expect(h.progressWrites).toEqual([100, 300]);
    expect(liveBytes[liveBytes.length - 1]).toBe(300);
  });

  it("does not broadcast progress that the repository refused", async () => {
    const runId = "bkr_refused_progress";
    h.artifacts = [{ name: "volume-pgdata.tar.zst", chunks: [100] }];
    h.rejectProgress = true;
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = backupRunBus.subscribe(runId, (event) =>
      events.push(event as Record<string, unknown>),
    );

    await new BackupOrchestrator().execute(runId);
    unsubscribe();

    expect(events.filter((event) => event.type === "progress")).toEqual([]);
    expect(h.row.bytesTransferred).toBe(100);
  });

  it("stops without a contradictory SSE verdict when another writer finalized the run", async () => {
    const runId = "bkr_finalized_elsewhere";
    h.artifacts = [{ name: "volume-pgdata.tar.zst", chunks: [100] }];
    h.finalizeAfterPutAs = "server_error";
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = backupRunBus.subscribe(runId, (event) =>
      events.push(event as Record<string, unknown>),
    );

    await new BackupOrchestrator().execute(runId);
    unsubscribe();

    expect(h.row.status).toBe("server_error");
    expect(events.some((event) => event.type === "complete")).toBe(false);
    expect(events.some((event) => event.status === "succeeded")).toBe(false);
    expect(h.notifications).toEqual([]);
    expect(h.deleted).toContain("openship/openship/postgres/bkr_live/volume-pgdata.tar.zst");
  });

  it("does not delete a successful winner's run-scoped objects", async () => {
    h.artifacts = [{ name: "volume-pgdata.tar.zst", chunks: [100] }];
    h.finalizeAfterPutAs = "succeeded";

    await new BackupOrchestrator().execute("bkr_duplicate_worker");

    expect(h.row.status).toBe("succeeded");
    expect(h.deleted).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("keeps heartbeating across a long upload while coalescing chunk storms", async () => {
    h.artifacts = [{ name: "volume-pgdata.tar.zst", chunks: [100, 100, 100] }];
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_500)
      .mockReturnValueOnce(2_100);

    try {
      await new BackupOrchestrator().execute("bkr_live");
    } finally {
      now.mockRestore();
    }

    expect(h.progressWrites).toEqual([100, 300]);
    expect(h.row.bytesTransferred).toBe(300);
  });
});

describe("backupRun.recordUploadProgress", () => {
  /** Fake drizzle chain for the progress write: update().set().where() with
   *  the status + monotonic guards mirrored by hand (same convention as
   *  backup-stale-sweep.test.ts — keep in sync with the repo). */
  function makeRunFake(initial: Record<string, unknown>) {
    const state = {
      db: null as unknown,
      row: { ...initial },
      applied: [] as Array<Record<string, unknown>>,
    };
    state.db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (state.row.status !== "uploading") return [];
              const incoming = values.bytesTransferred as number;
              if (
                typeof state.row.bytesTransferred === "number" &&
                state.row.bytesTransferred >= incoming
              ) {
                return [];
              }
              state.applied.push(values);
              Object.assign(state.row, values);
              return [{ id: state.row.id }];
            },
          }),
        }),
      }),
    };
    return state;
  }

  it("persists bytes and bumps the lastEventAt heartbeat on an uploading run", async () => {
    const fake = makeRunFake({
      id: "bkr_1",
      status: "uploading",
      bytesTransferred: null,
      lastEventAt: new Date(Date.now() - 60_000),
    });
    const repo = createBackupRunRepo(fake.db as never);

    expect(await repo.recordUploadProgress("bkr_1", 1_048_576)).toBe(true);

    expect(fake.row.bytesTransferred).toBe(1_048_576);
    expect((fake.row.lastEventAt as Date).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("refuses a value that does not advance the counter", async () => {
    const fake = makeRunFake({
      id: "bkr_1",
      status: "uploading",
      bytesTransferred: 2_000,
      lastEventAt: new Date(),
    });
    const repo = createBackupRunRepo(fake.db as never);

    expect(await repo.recordUploadProgress("bkr_1", 1_500)).toBe(false);
    expect(await repo.recordUploadProgress("bkr_1", 2_000)).toBe(false);

    expect(fake.applied).toEqual([]);
    expect(fake.row.bytesTransferred).toBe(2_000);
  });

  it("refuses a terminal row — a late write cannot resurrect a decided run", async () => {
    const fake = makeRunFake({
      id: "bkr_1",
      status: "failed",
      bytesTransferred: 0,
      lastEventAt: new Date(),
    });
    const repo = createBackupRunRepo(fake.db as never);

    expect(await repo.recordUploadProgress("bkr_1", 1_048_576)).toBe(false);

    expect(fake.applied).toEqual([]);
    expect(fake.row.bytesTransferred).toBe(0);
  });
});
