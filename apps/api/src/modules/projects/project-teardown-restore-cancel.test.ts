import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Force-deleting a project must STOP an in-flight restore, not just relabel it.
 *
 * The teardown used to flip the restore row to `cancelled` with a bare
 * `repos.backupRestore.transition` — its own comment admitted there was no worker-side
 * abort signal. There is one: the orchestrator holds the apply's AbortController. So
 * the row read `cancelled` while tar kept unpacking into volumes that the runtime
 * cleanup, a step or two later, was busy destroying underneath it.
 *
 * The wiring pinned here:
 *   • the cancel goes through the orchestrator, which aborts the extract
 *   • an `applying` restore gets the quiesce poll as its cooperative window
 *   • an apply that does not acknowledge cancellation KEEPS the project/resources;
 *     force-terminalizing only the row cannot prove extraction stopped
 *   • a restore that cancelled cleanly is never forced
 */

const h = vi.hoisted(() => ({
  /** In-flight restores, served until the row is cancelled. */
  restores: [] as Array<{ id: string; status: string }>,
  cancel: vi.fn(async (_ctx: unknown, restoreId: string, opts?: { force?: boolean }) => {
    const row = h.restores.find((r) => r.id === restoreId);
    // The real orchestrator leaves an `applying` row alone on a cooperative cancel
    // and takes it terminal when forced.
    const stopped = row?.status !== "applying" || opts?.force === true;
    if (row && stopped) row.status = "cancelled";
    return {
      accepted: true,
      status: stopped ? "cancelled" : "applying",
      destructive: false,
      forced: opts?.force === true,
    };
  }),
  restoreTransition: vi.fn(async () => {}),
  project: null as Record<string, unknown> | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: vi.fn(async () => h.project),
      claimDeletion: vi.fn(async () => true),
      deleteHard: vi.fn(async () => {}),
      clearDeletionInProgress: vi.fn(async () => {}),
      listByGroup: vi.fn(async () => [{ id: "p1" }]),
    },
    projectGroup: { softDelete: vi.fn(async () => {}) },
    deployment: { listInFlightByProject: vi.fn(async () => []) },
    backupRun: {
      listInFlightByProject: vi.fn(async () => []),
      cancelQueuedBeforeExecution: vi.fn(async () => false),
    },
    backupRestore: {
      listInFlightByProject: vi.fn(async () => h.restores.filter((r) => r.status !== "cancelled")),
      transition: h.restoreTransition,
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

vi.mock("../backups/restore.orchestrator", () => ({
  restoreOrchestrator: { cancel: h.cancel },
}));

vi.mock("./project-connection.service", () => ({
  unlinkConsumersOfSource: vi.fn(async () => ({ unlinked: [], errors: [] })),
}));
vi.mock("./project-cleanup.service", () => ({
  collectProjectManifest: vi.fn(async () => ({ projectId: "p1", resources: [] })),
  executeCleanup: vi.fn(async () => ({ total: 0, succeeded: 0, failed: [] })),
  hasPendingTimedOutCleanup: vi.fn(() => false),
}));
vi.mock("../../lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_projectId: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../../lib/openship-manifest-sync", () => ({
  removeProjectFromServerManifests: vi.fn(async () => {}),
}));
vi.mock("../deployments/build.service", () => ({
  cancelBuildSession: vi.fn(async () => ({ success: true })),
}));
vi.mock("../github/github.service", () => ({ deleteWebhook: vi.fn(async () => {}) }));
vi.mock("../mail/webmail/webmail-install.service", () => ({
  cleanupWebmailInstall: vi.fn(async () => null),
}));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false } }));

import { teardownProject, type TeardownStep } from "./project-teardown";

const ctx = { organizationId: "org1", userId: "u1" } as never;

const run = () =>
  teardownProject(ctx, "p1", { force: true }) as Promise<{
    steps: TeardownStep[];
    rowDeleted: boolean;
  }>;

const stepOf = (steps: TeardownStep[], name: string) => steps.find((s) => s.step === name);

beforeEach(() => {
  vi.clearAllMocks();
  h.restores = [];
  h.project = {
    id: "p1",
    organizationId: "org1",
    groupId: "g1",
    slug: "app",
    framework: "nextjs",
    appTemplateId: null,
    cloudWorkspaceId: null,
    webhookId: null,
    gitOwner: null,
    gitRepo: null,
    deletedAt: null,
    deletionInProgress: false,
  };
});

describe("force teardown vs. an in-flight restore", () => {
  it("cancels through the orchestrator, not with a bare status flip", async () => {
    h.restores = [{ id: "bks_1", status: "preparing" }];
    const { steps } = await run();

    expect(h.cancel).toHaveBeenCalledWith(ctx, "bks_1");
    // The flip is what left the extract running; nothing should reach for it.
    expect(h.restoreTransition).not.toHaveBeenCalled();
    expect(stepOf(steps, "cancel_in_flight")?.status).toBe("ok");
  });

  it("keeps the project when an applying restore does not answer the quiesce window", async () => {
    h.restores = [{ id: "bks_1", status: "applying" }];
    const result = await run();

    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.cancel).toHaveBeenCalledWith(ctx, "bks_1");
    expect(result.rowDeleted).toBe(false);
    expect(stepOf(result.steps, "cancel_in_flight")?.error).toMatch(/cancellation pending/);
  });

  it("does not force one that cancelled cleanly", async () => {
    h.restores = [{ id: "bks_1", status: "prepared" }];
    await run();
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels every in-flight restore, and one failure does not skip the rest", async () => {
    h.restores = [
      { id: "bks_1", status: "preparing" },
      { id: "bks_2", status: "preparing" },
      { id: "bks_3", status: "preparing" },
    ];
    h.cancel.mockImplementationOnce(async () => {
      throw new Error("gone");
    });
    const { steps } = await run();

    expect(h.cancel.mock.calls.filter((c) => c.length === 2).map((c) => c[1])).toEqual([
      "bks_1",
      "bks_2",
      "bks_3",
    ]);
    // bks_1 threw, so it never left the in-flight list. The timeout is surfaced,
    // but no DB-only force transition may pretend the writer stopped.
    expect(h.cancel.mock.calls.some((call) => call[2]?.force === true)).toBe(false);
    expect(stepOf(steps, "cancel_in_flight")?.error).toMatch(/backup_restore bks_1: gone/);
  });

  it("touches nothing when no restore is in flight", async () => {
    const { steps } = await run();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(stepOf(steps, "cancel_in_flight")?.details).toBe("nothing in flight");
  });
});
