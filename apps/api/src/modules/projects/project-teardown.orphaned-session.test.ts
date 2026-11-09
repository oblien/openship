import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Force-deleting a project must not 409 forever on a build session orphaned
 * by a deployment that already reached a terminal status (#1682).
 *
 * The reporter's shape: DELETE /api/projects/:id returns 409
 * PROJECT_HAS_ACTIVE_WORK forever when a deployment reached `cancelled`
 * while its build_session was left with started_at set and finished_at null
 * — the worker is gone, so the quiescence gate can never be satisfied, and
 * even ?force=true times out after 5000ms. Only the boot-time sweep could
 * clear it.
 *
 * The wiring pinned here:
 *   • a forced delete settles exactly the orphaned sessions of
 *     already-terminal deployments (via the same acknowledgeBuildExecutionFinished
 *     write the worker's own finally and the boot sweep perform), then the
 *     gate re-reads — and the row is deleted
 *   • a still-running deployment is never settled: it keeps blocking
 *   • a `reconciling` deployment is never settled: reconciliation is active work
 *   • settling an orphan does not rescue a delete blocked by OTHER live work
 *   • a graceful delete never settles: it refuses up front, as before
 */

const h = vi.hoisted(() => ({
  /** Deployments, served until their session is acknowledged finished. */
  deployments: [] as Array<{
    id: string;
    status: string;
    session: { id: string; startedAt: Date | null; finishedAt: Date | null } | null;
  }>,
  backupRuns: [] as Array<{ id: string; status: string }>,
  acknowledge: vi.fn(async (sessionId: string) => {
    const dep = h.deployments.find((d) => d.session?.id === sessionId);
    // The real repo only stamps finishedAt where startedAt IS NOT NULL AND
    // finishedAt IS NULL — a live worker's finally and this ack are the same write.
    if (dep?.session && dep.session.startedAt && !dep.session.finishedAt) {
      dep.session.finishedAt = new Date();
    }
  }),
  project: null as Record<string, unknown> | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    clusterDatabase: { list: vi.fn(async () => []) },
    project: {
      findById: vi.fn(async () => h.project),
      claimDeletion: vi.fn(async () => true),
      beginDeletionCleanup: vi.fn(async () => true),
      deleteHard: vi.fn(async () => {}),
      clearDeletionInProgress: vi.fn(async () => {}),
      markDeletionFailed: vi.fn(async () => {}),
      listByGroup: vi.fn(async () => [{ id: "p1" }]),
    },
    projectGroup: { softDelete: vi.fn(async () => {}) },
    deployment: {
      listInFlightByProject: vi.fn(async () =>
        h.deployments.filter(
          (d) =>
            ["queued", "building", "deploying"].includes(d.status) ||
            (d.session?.startedAt != null && d.session.finishedAt == null),
        ),
      ),
      findById: vi.fn(async (id: string) => h.deployments.find((d) => d.id === id) ?? null),
      findBuildSessionByDeploymentId: vi.fn(
        async (depId: string) => h.deployments.find((d) => d.id === depId)?.session ?? null,
      ),
      acknowledgeBuildExecutionFinished: h.acknowledge,
    },
    backupRun: {
      listInFlightByProject: vi.fn(async () =>
        h.backupRuns.filter((r) => r.status !== "cancelled"),
      ),
      cancelQueuedBeforeExecution: vi.fn(async () => false),
    },
    backupRestore: {
      listInFlightByProject: vi.fn(async () => []),
      transition: vi.fn(async () => {}),
    },
    dockerMigrationRun: { findActiveForProject: vi.fn(async () => null) },
    orphanedResource: {
      create: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      listByProject: vi.fn(async () => []),
    },
    projectConnection: { listBySource: vi.fn(async () => []) },
  },
}));

vi.mock("@repo/platform/engine/modules/backups/restore.orchestrator", () => ({
  restoreOrchestrator: { cancel: vi.fn(async () => ({ accepted: true, status: "cancelled" })) },
}));

vi.mock("@repo/platform/engine/modules/projects/project-connection.service", () => ({
  unlinkConsumersOfSource: vi.fn(async () => ({ unlinked: [], errors: [] })),
}));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", () => ({
  collectProjectManifest: vi.fn(async () => ({ projectId: "p1", resources: [] })),
  executeCleanup: vi.fn(async () => ({ total: 0, succeeded: 0, failed: [] })),
  hasPendingTimedOutCleanup: vi.fn(() => false),
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectStateLock: async (_id: string, work: () => Promise<unknown>) => work(),
  withProjectRuntimeLock: async (_projectId: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("@repo/platform/engine/lib/openship-manifest-sync", () => ({
  removeProjectFromServerManifests: vi.fn(async () => {}),
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  cancelBuildSession: vi.fn(async () => ({ success: true })),
}));
vi.mock("@repo/platform/engine/modules/github/github.service", () => ({
  deleteWebhook: vi.fn(async () => {}),
}));
vi.mock("@repo/platform/engine/modules/mail/webmail/webmail-install.service", () => ({
  cleanupWebmailInstall: vi.fn(async () => null),
}));
vi.mock("@repo/platform/engine/config/index", () => ({ env: { CLOUD_MODE: false } }));

import {
  teardownProject,
  type TeardownStep,
} from "@repo/platform/engine/modules/projects/project-teardown";

const ctx = { organizationId: "org1", userId: "u1" } as never;

const run = (opts: { force: boolean }) =>
  teardownProject(ctx, "p1", opts) as Promise<{
    steps: TeardownStep[];
    rowDeleted: boolean;
    rejection?: string;
  }>;

const stepOf = (steps: TeardownStep[], name: string) => steps.find((s) => s.step === name);

/** The reporter's exact shape: terminal row, worker gone, session never finished. */
const orphanedCancelled = () => ({
  id: "dep-orphan",
  status: "cancelled",
  session: { id: "sess-orphan", startedAt: new Date("2026-11-08T20:00:00Z"), finishedAt: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.deployments = [];
  h.backupRuns = [];
  h.project = {
    id: "p1",
    organizationId: "org1",
    groupId: "g1",
    slug: "app",
    framework: "nextjs",
    appTemplateId: null,
    workspaceId: null,
    webhookId: null,
    gitOwner: null,
    gitRepo: null,
    deletedAt: null,
    deletionInProgress: false,
  };
});

describe("force teardown vs. an orphaned build session (#1682)", () => {
  it("settles the orphaned session of an already-cancelled deployment and deletes the row", async () => {
    vi.useFakeTimers();
    try {
      h.deployments = [orphanedCancelled()];

      const pending = run({ force: true });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;

      expect(h.acknowledge).toHaveBeenCalledWith("sess-orphan");
      expect(stepOf(res.steps, "cancel_in_flight")?.status).toBe("ok");
      expect(stepOf(res.steps, "cancel_in_flight")?.details).toMatch(/orphaned build session/);
      expect(res.rowDeleted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never settles a deployment that is still building", async () => {
    vi.useFakeTimers();
    try {
      h.deployments = [
        {
          id: "dep-live",
          status: "building",
          session: { id: "sess-live", startedAt: new Date(), finishedAt: null },
        },
      ];

      const pending = run({ force: true });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;

      expect(h.acknowledge).not.toHaveBeenCalled();
      expect(stepOf(res.steps, "cancel_in_flight")?.status).toBe("failed");
      expect(stepOf(res.steps, "cancel_in_flight")?.error).toMatch(
        /Timed out waiting for quiescence/,
      );
      expect(res.rowDeleted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never settles a reconciling deployment", async () => {
    vi.useFakeTimers();
    try {
      h.deployments = [
        {
          id: "dep-reconciling",
          status: "reconciling",
          session: { id: "sess-reconciling", startedAt: new Date(), finishedAt: null },
        },
      ];

      const pending = run({ force: true });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;

      expect(h.acknowledge).not.toHaveBeenCalled();
      expect(res.rowDeleted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the row when other genuinely-active work remains, even after settling the orphan", async () => {
    vi.useFakeTimers();
    try {
      h.deployments = [orphanedCancelled()];
      h.backupRuns = [{ id: "backup-1", status: "uploading" }];

      const pending = run({ force: true });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;

      // The terminal deployment's session is settled on its own merits, but the
      // capture still holds an execution lease, so the row stays.
      expect(h.acknowledge).toHaveBeenCalledWith("sess-orphan");
      expect(stepOf(res.steps, "cancel_in_flight")?.status).toBe("failed");
      expect(res.rowDeleted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a graceful delete refuses up front and never settles", async () => {
    h.deployments = [orphanedCancelled()];

    const res = await run({ force: false });

    expect(h.acknowledge).not.toHaveBeenCalled();
    expect(res.rejection).toBe("active_work");
    expect(res.rowDeleted).toBe(false);
  });
});
