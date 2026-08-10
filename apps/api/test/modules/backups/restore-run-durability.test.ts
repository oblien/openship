/**
 * A restore's FAILURE write must not be the thing that fails.
 *
 * `errorMessage: message.slice(0, TRUNCATE_ERROR)` put raw remote error text
 * (`tar: …`, `pg_restore: …`, an SSH banner) straight into a text column, in the
 * same statement as the terminal `failed` status. A NUL byte there made the
 * failure write throw out of the catch block that was recording the failure —
 * so the restore stayed in `preparing`/`applying` forever with no reason
 * recorded, and the SSE channel never reached a terminal event.
 *
 * The `.slice` also split surrogate pairs; the fake below refuses what Postgres
 * refuses so the write path is exercised for real.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import { createBackupRestoreRepo } from "../../../../../packages/db/src/repos/backup.repo";

interface PgFake {
  db: unknown;
  row: Record<string, unknown>;
  rejections: string[];
}

function makePgFake(initial: Record<string, unknown> = {}): PgFake {
  const state: PgFake = { db: null, row: { ...initial }, rejections: [] };
  state.db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          for (const [key, value] of Object.entries(values)) {
            if (typeof value === "string" && value.includes("\u0000")) {
              const reason = 'invalid byte sequence for encoding "UTF8": 0x00';
              state.rejections.push(`${key}: ${reason}`);
              throw new Error(reason);
            }
          }
          Object.assign(state.row, values);
        },
      }),
    }),
  };
  return state;
}

// ─── Layer 1: the repo ───────────────────────────────────────────────────────

describe("backupRestore.transition — the terminal status is not the payload's hostage", () => {
  it("records failed even when the error text is unstorable", async () => {
    const pg = makePgFake({ id: "bks_1", status: "applying" });
    const repo = createBackupRestoreRepo(pg.db as never);

    await repo.transition("bks_1", "failed", {
      errorMessage: "pg_restore:\u0000 could not execute",
      bytesRestored: 128,
    } as never);

    expect(pg.row.status).toBe("failed");
    expect(pg.row.finishedAt).toBeInstanceOf(Date);
    expect(pg.row.bytesRestored).toBe(128);
    // Not blank: a failed restore with no reason reads as "no reason given".
    expect(String(pg.row.errorMessage)).toContain("unstorable");
    expect(pg.rejections.length).toBeGreaterThan(0);
  });
});

// ─── Layer 2: the orchestrator ───────────────────────────────────────────────

const h = vi.hoisted(() => ({
  transition: null as
    | null
    | ((id: string, status: string, patch?: Record<string, unknown>) => Promise<void>),
  restoreRow: null as Record<string, unknown> | null,
  headError: "",
  terminal: null as null | (() => void),
  notifications: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => ({
        id: "bkr_1",
        status: "succeeded",
        destinationId: "dst_1",
        organizationId: "org_1",
        projectId: "prj_1",
        serviceId: "svc_1",
        sourceKind: "service",
        deletedAt: null,
        artifacts: [{ key: "pfx/vol.tar", sha256: "d0", sizeBytes: 10 }],
      }),
    },
    backupDestination: {
      findById: async () => ({ id: "dst_1", organizationId: "org_1", name: "S3" }),
    },
    backupRestore: {
      findActiveByRunId: async () => undefined,
      create: async (row: Record<string, unknown>) => {
        h.restoreRow = row;
        return row;
      },
      findById: async () => h.restoreRow,
      transition: async (id: string, status: string, patch?: Record<string, unknown>) => {
        await h.transition!(id, status, patch);
        if (status === "failed" || status === "succeeded") h.terminal?.();
      },
    },
    project: {
      findById: async () => ({ id: "prj_1", name: "shop", slug: "shop", activeDeploymentId: null }),
      listEnvVars: async () => [],
    },
    service: {
      findById: async () => ({
        id: "svc_1",
        projectId: "prj_1",
        name: "db",
        image: "postgres:16",
        environment: {},
        volumes: ["/var/lib/postgresql/data"],
        namespaceVolumes: true,
      }),
      listByProject: async () => [{ id: "svc_1" }],
    },
    deployment: { findById: async () => null },
  },
}));

vi.mock("@repo/adapters", () => ({
  resolveDestination: () => ({
    head: async () => {
      throw new Error(h.headError);
    },
    get: async () => null,
  }),
  // Prepare resolves the target to preflight it, so the executor has to answer
  // listSources — the artifact here is not a volume, so nothing gates on it.
  resolveExecutor: () => ({ runtimeName: "docker", listSources: async () => [] }),
  matchBackupSource: () => null,
  validateManifest: (v: unknown) => v,
  resolveProducer: () => ({}),
  HashingPassthrough: class {},
  artifactKey: () => "k",
  manifestKey: () => "m",
  runPrefix: () => "p/",
  buildManifest: () => ({}),
  resolveProducerForService: () => ({}),
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: async () => ({ platform: { runtime: { name: "docker" } } }),
  resolveTargetPlatform: async () => ({ runtime: { name: "bare" } }),
}));

vi.mock("../../../src/lib/encryption", () => ({ decryptEnvMap: (v: unknown) => v }));

vi.mock("../../../src/lib/job-runner", () => ({
  getJobRunner: async () => ({ enqueueRun: async () => {} }),
}));

vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: {
    emit: (e: { eventType: string; payload: Record<string, unknown> }) => {
      h.notifications.push(e);
    },
  },
}));

vi.mock("../../../src/modules/backup-destinations/hydrate-server", () => ({
  toAdapterRow: async (row: unknown) => row,
}));

vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdForService: async () => null,
}));

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";

function wireRestore(): PgFake {
  const pg = makePgFake({ id: "bks_live", status: "queued" });
  const repo = createBackupRestoreRepo(pg.db as never);
  h.transition = (id, status, patch) => repo.transition(id, status as never, patch as never);
  return pg;
}

beforeEach(() => {
  h.restoreRow = null;
  h.headError = "";
  h.terminal = null;
  h.notifications.length = 0;
});

describe("RestoreOrchestrator.beginPrepare — failure reason survives the write", () => {
  it("records failed with a scrubbed reason when the remote error carries a NUL", async () => {
    h.headError = "tar: /var/vmail:\u0000 Cannot open: Permission denied";
    const pg = wireRestore();
    const reachedTerminal = new Promise<void>((resolve) => {
      h.terminal = resolve;
    });

    await new RestoreOrchestrator().beginPrepare({
      runId: "bkr_1",
      trigger: { source: "manual", userId: "usr_1" } as never,
      confirmationToken: "t".repeat(32),
    });
    await reachedTerminal;

    expect(pg.row.status).toBe("failed");
    const message = String(pg.row.errorMessage);
    // The reason is KEPT (scrubbed), not shed as an unstorable marker.
    expect(message).toContain("Cannot open: Permission denied");
    expect(message).not.toContain("unstorable");
    expect(message).not.toContain("\u0000");
    expect(pg.rejections).toEqual([]);
    // The terminal notification carries the same scrubbed text. It is emitted a
    // couple of awaits AFTER the status write (the dispatcher re-reads the run and
    // its project first), so `h.terminal` resolving is not enough to observe it.
    await vi.waitFor(() =>
      expect(h.notifications.map((n) => n.eventType)).toEqual(["backup_restore.failed"]),
    );
    expect(String(h.notifications[0].payload.errorMessage)).not.toContain("\u0000");
  });

  it("leaves no lone surrogate when the reason is longer than the cap", async () => {
    // 4096 is the cap; an unbroken run of astral characters guarantees the cut
    // lands between a high and a low surrogate.
    h.headError = `head failed: ${"🚀".repeat(4096)}`;
    const pg = wireRestore();
    const reachedTerminal = new Promise<void>((resolve) => {
      h.terminal = resolve;
    });

    await new RestoreOrchestrator().beginPrepare({
      runId: "bkr_1",
      trigger: { source: "manual", userId: "usr_1" } as never,
      confirmationToken: "t".repeat(32),
    });
    await reachedTerminal;

    expect(pg.row.status).toBe("failed");
    expect(String(pg.row.errorMessage).isWellFormed()).toBe(true);
  });
});
