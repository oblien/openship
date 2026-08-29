import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Record-only ("Remove from Openship only") delete contract.
 *
 * The UI promises "Nothing on the server is touched — the app keeps running with
 * its data". That is a HARD guarantee, so this pins every destructive door shut:
 *
 *   • no runtime cleanup   → no container / image / volume / network destroy
 *                            AND no route removal (routes live in the same
 *                            manifest, so a skipped cleanup keeps the vhost
 *                            serving)
 *   • no webmail teardown  → the mail server's proxy vhost for it stays up
 *   • no manifest rewrite  → the server's .openship manifest still lists the
 *                            project, so a later Docker scan can re-import it
 *   • no orphan records    → nothing for the GC sweep to reclaim later
 *   • force-cancel of an in-flight deploy keeps what it provisioned (the
 *     dashboard auto-escalates to force=true on active work, and that cancel
 *     normally destroys containers + images)
 *
 * …and asserts the escape hatch stays closed: a CLOUD project ignores
 * recordOnly and tears down for real (its resources live on Oblien).
 */

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  activeDeployments: [] as Array<{ id: string; status: string }>,
  activeDeploymentReadError: null as Error | null,
  keepDeploymentsActive: false,
  activeBackupRuns: [] as Array<{ id: string; status: string }>,
  activeMigration: null as { id: string; status: string } | null,
  // Serves the active list once, then empty — so the quiesce poll converges
  // instead of burning the 5s timeout.
  listByProjectCalls: 0,

  /** Links from the app being deleted into the projects using it. */
  consumers: [] as Array<{
    id: string;
    targetProjectId: string;
    envKey: string;
    mode: string;
  }>,
  unlinkConsumersOfSource: vi.fn(
    async (links: Array<{ id: string; targetProjectId: string; envKey: string }>) => ({
      unlinked: links.map((l) => ({
        linkId: l.id,
        projectId: l.targetProjectId,
        projectName: l.targetProjectId,
        envKey: l.envKey,
      })),
      errors: [] as string[],
    }),
  ),

  claimDeletion: vi.fn(async () => true),
  deleteHard: vi.fn(async () => {}),
  clearDeletionInProgress: vi.fn(async () => {}),
  listByGroup: vi.fn(async () => [{ id: "p1" }]),
  softDeleteGroup: vi.fn(async () => {}),
  orphanCreate: vi.fn(async (_row: Record<string, unknown>) => ({ id: "orphan-created" })),
  orphanDelete: vi.fn(async () => {}),
  orphanListByProject: vi.fn(async () => [] as Array<Record<string, unknown>>),

  collectProjectManifest: vi.fn(async () => ({ projectId: "p1", resources: [] })),
  executeCleanup: vi.fn(async () => ({ total: 0, succeeded: 0, failed: [] })),
  disposeManifestRuntimes: vi.fn(),
  removeProjectFromServerManifests: vi.fn(async () => {}),
  cancelBuildSession: vi.fn(async () => ({ success: true })),
  cancelMigration: vi.fn(async () => {
    h.activeMigration = null;
    return { ok: true as const };
  }),
  cancelQueuedBackup: vi.fn(async (id: string) => {
    const run = h.activeBackupRuns.find((candidate) => candidate.id === id);
    if (run?.status !== "queued") return false;
    h.activeBackupRuns = h.activeBackupRuns.filter((candidate) => candidate.id !== id);
    return true;
  }),
  transitionBackupRun: vi.fn(async () => {}),
  deleteGitHubWebhook: vi.fn(async () => {}),
  cleanupWebmailInstall: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: vi.fn(async () => h.project),
      claimDeletion: h.claimDeletion,
      deleteHard: h.deleteHard,
      clearDeletionInProgress: h.clearDeletionInProgress,
      listByGroup: h.listByGroup,
    },
    projectGroup: { softDelete: h.softDeleteGroup },
    deployment: {
      listInFlightByProject: vi.fn(async () => {
        if (h.activeDeploymentReadError) throw h.activeDeploymentReadError;
        return h.listByProjectCalls++ === 0 || h.keepDeploymentsActive ? h.activeDeployments : [];
      }),
    },
    backupRun: {
      listInFlightByProject: vi.fn(async () => h.activeBackupRuns),
      cancelQueuedBeforeExecution: h.cancelQueuedBackup,
      transition: h.transitionBackupRun,
    },
    backupRestore: { listInFlightByProject: vi.fn(async () => []) },
    dockerMigrationRun: { findActiveForProject: vi.fn(async () => h.activeMigration) },
    orphanedResource: {
      create: h.orphanCreate,
      delete: h.orphanDelete,
      listByProject: h.orphanListByProject,
    },
    projectConnection: { listBySource: vi.fn(async () => h.consumers) },
  },
}));

vi.mock("./project-connection.service", () => ({
  unlinkConsumersOfSource: h.unlinkConsumersOfSource,
}));

vi.mock("./project-cleanup.service", () => ({
  collectProjectManifest: h.collectProjectManifest,
  executeCleanup: h.executeCleanup,
  disposeManifestRuntimes: h.disposeManifestRuntimes,
  hasPendingTimedOutCleanup: vi.fn(() => false),
}));
vi.mock("../../lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_projectId: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../../lib/openship-manifest-sync", () => ({
  removeProjectFromServerManifests: h.removeProjectFromServerManifests,
}));
vi.mock("../deployments/build.service", () => ({
  cancelBuildSession: h.cancelBuildSession,
}));
vi.mock("../migration/migration.orchestrator", () => ({
  migrationOrchestrator: { cancel: h.cancelMigration },
}));
vi.mock("../github/github.service", () => ({ deleteWebhook: h.deleteGitHubWebhook }));
vi.mock("../mail/webmail/webmail-install.service", () => ({
  cleanupWebmailInstall: h.cleanupWebmailInstall,
}));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false } }));

import { teardownProject, type TeardownStep } from "./project-teardown";

const ctx = { organizationId: "org1", userId: "u1" } as never;

const projectFixture = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

const stepOf = (steps: TeardownStep[], name: string) => steps.find((s) => s.step === name);

beforeEach(() => {
  vi.clearAllMocks();
  h.project = projectFixture();
  h.activeDeployments = [];
  h.activeDeploymentReadError = null;
  h.keepDeploymentsActive = false;
  h.activeBackupRuns = [];
  h.activeMigration = null;
  h.listByProjectCalls = 0;
  h.consumers = [];
});

describe("teardownProject — the GitHub webhook step vs. repo write access", () => {
  const linkedToRepo = { webhookId: 99, gitOwner: "acme", gitRepo: "production-api" };

  it("a denial from the GitHub access gate is a SKIP, not a failed teardown", async () => {
    // Deleting the PROJECT is `project:admin`, which a member holds; deleting the
    // repo's webhook needs WRITE on the repo, which they may not. Borrowing a wider
    // credential to do it anyway is GHSA-hp2g-hw7g-f3vm, so not touching their repo
    // is the correct outcome — and must not turn a clean delete into a 207.
    h.project = projectFixture(linkedToRepo);
    h.deleteGitHubWebhook.mockRejectedValueOnce(
      Object.assign(new Error("You don't have access to acme/production-api."), {
        statusCode: 403,
        code: "GITHUB_ACCESS_DENIED",
      }),
    );

    const res = await teardownProject(ctx, "p1", { force: true, recordOnly: false });

    const step = stepOf(res.steps, "github_webhook");
    expect(step?.status).toBe("skipped");
    expect(step?.details).toMatch(/no write access/i);
    expect(res.rowDeleted).toBe(true);
  });

  it("an unrelated GitHub error is still a real failure", async () => {
    h.project = projectFixture(linkedToRepo);
    h.deleteGitHubWebhook.mockRejectedValueOnce(new Error("GitHub API error (500): boom"));

    const res = await teardownProject(ctx, "p1", { force: true, recordOnly: false });

    expect(stepOf(res.steps, "github_webhook")?.status).toBe("failed");
  });
});

describe("teardownProject — deleting a linked app unlinks it from the projects using it", () => {
  it("unlinks every consuming project instead of refusing the delete", async () => {
    // `project_connection.sourceProjectId` is ON DELETE RESTRICT, so the links
    // have to go before the row can drop. The consuming projects are NOT touched
    // beyond losing the injected env var — they keep running.
    h.consumers = [
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL", mode: "internal" },
      { id: "conn_b", targetProjectId: "app-b", envKey: "DATABASE_URL", mode: "internal" },
    ];

    const res = await teardownProject(ctx, "p1", { force: true, recordOnly: false });

    expect(res.rejection).toBeUndefined();
    expect(res.rowDeleted).toBe(true);
    expect(h.unlinkConsumersOfSource).toHaveBeenCalledWith(h.consumers);
    expect(res.unlinked.map((u) => u.projectId)).toEqual(["app-a", "app-b"]);
    expect(stepOf(res.steps, "unlink_consumers")?.status).toBe("ok");
  });

  it("unlinks AFTER the runtime is clean — a kept row never strips another project's env", async () => {
    // The atomicity gate keeps the row when cleanup fails (unreachable server).
    // Unlinking before that point would leave a live project pointing at nothing
    // while the app it points at is still there.
    h.consumers = [
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL", mode: "internal" },
    ];
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      resources: [{ type: "container", ref: "c1", label: "container c1" }],
    } as never);
    h.executeCleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "container c1", error: "ssh timeout" }],
    } as never);

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(false);
    expect(h.unlinkConsumersOfSource).not.toHaveBeenCalled();
    expect(h.deleteHard).not.toHaveBeenCalled();
  });

  it("keeps the row when a link can't be removed — the FK would refuse the drop anyway", async () => {
    h.consumers = [
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL", mode: "internal" },
    ];
    h.unlinkConsumersOfSource.mockResolvedValueOnce({
      unlinked: [],
      errors: ["DATABASE_URL on app-a: db down"],
    });

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(false);
    expect(h.deleteHard).not.toHaveBeenCalled();
    expect(stepOf(res.steps, "unlink_consumers")?.status).toBe("failed");
    expect(res.canForceOrphan).toBe(false);
  });

  it("unlinks on a record-only delete too — the row (and its links) still go", async () => {
    h.consumers = [
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL", mode: "internal" },
    ];

    const res = await teardownProject(ctx, "p1", { force: false, recordOnly: true });

    expect(res.rowDeleted).toBe(true);
    expect(h.unlinkConsumersOfSource).toHaveBeenCalled();
  });

  it("touches nothing connection-related when the app isn't linked anywhere", async () => {
    h.consumers = [];
    const res = await teardownProject(ctx, "p1", { force: false, recordOnly: true });

    expect(res.rowDeleted).toBe(true);
    expect(h.unlinkConsumersOfSource).not.toHaveBeenCalled();
    expect(stepOf(res.steps, "unlink_consumers")).toBeUndefined();
  });
});

describe("teardownProject — force-orphan contract", () => {
  it("rechecks active work under the deletion lock for a graceful delete", async () => {
    h.activeDeployments = [{ id: "dep-race", status: "queued" }];

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rejection).toBe("active_work");
    expect(res.active?.activeDeploymentIds).toEqual(["dep-race"]);
    expect(res.rowDeleted).toBe(false);
    expect(h.collectProjectManifest).not.toHaveBeenCalled();
    expect(h.deleteHard).not.toHaveBeenCalled();
  });

  it("fails closed and releases the lock when active work cannot be read", async () => {
    h.activeDeploymentReadError = new Error("work table unavailable");

    await expect(teardownProject(ctx, "p1", { force: false })).rejects.toThrow(
      /work table unavailable/,
    );

    expect(h.clearDeletionInProgress).toHaveBeenCalledWith("p1");
    expect(h.collectProjectManifest).not.toHaveBeenCalled();
    expect(h.deleteHard).not.toHaveBeenCalled();
  });

  it("cancels active work when forceOrphan is requested directly", async () => {
    h.activeDeployments = [{ id: "d1", status: "building" }];

    const res = await teardownProject(ctx, "p1", { force: false, forceOrphan: true });

    expect(h.cancelBuildSession).toHaveBeenCalledWith("d1", { keepProvisioned: true });
    expect(res.rowDeleted).toBe(true);
  });

  it("waits for a Docker migration's orchestrated rollback before deleting", async () => {
    h.activeMigration = { id: "dmr-1", status: "moving_data" };

    const res = await teardownProject(ctx, "p1", { force: true });

    expect(h.cancelMigration).toHaveBeenCalledWith("dmr-1", "org1");
    expect(stepOf(res.steps, "cancel_in_flight")?.status).toBe("ok");
    expect(res.rowDeleted).toBe(true);
  });

  it("keeps the row and resources tracked when forced cancellation never quiesces", async () => {
    vi.useFakeTimers();
    try {
      h.activeDeployments = [{ id: "d1", status: "building" }];
      h.keepDeploymentsActive = true;

      const pending = teardownProject(ctx, "p1", { force: false, forceOrphan: true });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;

      expect(stepOf(res.steps, "cancel_in_flight")?.status).toBe("failed");
      expect(stepOf(res.steps, "delete_db_row")?.details).toMatch(/did not quiesce/i);
      expect(res.rowDeleted).toBe(false);
      expect(res.canForceOrphan).toBe(false);
      expect(h.collectProjectManifest).not.toHaveBeenCalled();
      expect(h.executeCleanup).not.toHaveBeenCalled();
      expect(h.unlinkConsumersOfSource).not.toHaveBeenCalled();
      expect(h.deleteHard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never pretends an active backup capture was cancelled by changing only its row", async () => {
    vi.useFakeTimers();
    try {
      h.activeBackupRuns = [{ id: "backup-1", status: "uploading" }];

      const pending = teardownProject(ctx, "p1", { force: false, forceOrphan: true });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;

      expect(h.transitionBackupRun).not.toHaveBeenCalled();
      expect(stepOf(res.steps, "cancel_in_flight")?.error).toMatch(
        /backup capture cannot be cancelled safely/i,
      );
      expect(res.rowDeleted).toBe(false);
      expect(res.canForceOrphan).toBe(false);
      expect(h.collectProjectManifest).not.toHaveBeenCalled();
      expect(h.deleteHard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an unclaimed queued backup instead of waiting forever", async () => {
    h.activeBackupRuns = [{ id: "backup-queued", status: "queued" }];

    const res = await teardownProject(ctx, "p1", { force: true });

    expect(h.cancelQueuedBackup).toHaveBeenCalledWith("backup-queued", "p1", "org1");
    expect(stepOf(res.steps, "cancel_in_flight")?.status).toBe("ok");
    expect(res.rowDeleted).toBe(true);
  });

  it("offers force-orphan only after reachable resource destruction fails", async () => {
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      resources: [{ type: "container", ref: "c1", label: "container c1" }],
    } as never);
    h.executeCleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "container c1", error: "ssh timeout" }],
    } as never);

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(false);
    expect(res.canForceOrphan).toBe(true);
  });

  it("does not offer force-orphan when manifest collection itself fails", async () => {
    h.collectProjectManifest.mockRejectedValueOnce(new Error("deployment metadata unavailable"));

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(false);
    expect(res.canForceOrphan).toBe(false);
    expect(stepOf(res.steps, "runtime_cleanup")?.error).toMatch(/manifest collection failed/i);
  });

  it("does not offer force-orphan when webmail cleanup also failed", async () => {
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      resources: [{ type: "container", ref: "c1", label: "container c1" }],
    } as never);
    h.executeCleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "container c1", error: "ssh timeout" }],
    } as never);
    h.cleanupWebmailInstall.mockRejectedValueOnce(new Error("mail host unavailable"));

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(false);
    expect(res.canForceOrphan).toBe(false);
    expect(stepOf(res.steps, "webmail")?.status).toBe("failed");
  });
});

describe("teardownProject — record-only delete touches nothing on the server", () => {
  it("drops the row while skipping runtime cleanup, webmail, and the server manifest", async () => {
    const res = await teardownProject(ctx, "p1", { force: false, recordOnly: true });

    expect(res.rowDeleted).toBe(true);
    expect(res.ok).toBe(true);

    // The destructive doors — all shut.
    expect(h.collectProjectManifest).not.toHaveBeenCalled();
    expect(h.executeCleanup).not.toHaveBeenCalled();
    expect(h.cleanupWebmailInstall).not.toHaveBeenCalled();
    expect(h.removeProjectFromServerManifests).not.toHaveBeenCalled();
    // Nothing recorded for the GC sweep to reclaim after the row is gone.
    expect(h.orphanCreate).not.toHaveBeenCalled();

    expect(stepOf(res.steps, "runtime_cleanup")?.status).toBe("skipped");
    expect(stepOf(res.steps, "webmail")?.status).toBe("skipped");
    expect(h.deleteHard).toHaveBeenCalledWith("p1");
  });

  it("leaves a webmail project's install standing even though the row drops", async () => {
    h.project = projectFixture({
      appTemplateId: "webmail",
      framework: "docker-compose",
      slug: "webmail-example-com",
    });

    await teardownProject(ctx, "p1", { force: false, recordOnly: true });

    expect(h.cleanupWebmailInstall).not.toHaveBeenCalled();
  });

  it("force-cancels an in-flight deploy WITHOUT destroying what it provisioned", async () => {
    h.activeDeployments = [{ id: "d1", status: "building" }];

    const res = await teardownProject(ctx, "p1", { force: true, recordOnly: true });

    expect(h.cancelBuildSession).toHaveBeenCalledWith("d1", { keepProvisioned: true });
    expect(h.executeCleanup).not.toHaveBeenCalled();
    expect(res.rowDeleted).toBe(true);
  });

  it("still tears the runtime down when the same cancel runs for a REAL delete", async () => {
    h.activeDeployments = [{ id: "d1", status: "building" }];
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      resources: [{ type: "container", ref: "c1", label: "container c1" }],
    } as never);

    await teardownProject(ctx, "p1", { force: true, recordOnly: false });

    // Cancellation itself must not clean underneath a still-running worker;
    // canonical runtime cleanup runs only after the worker lease is gone.
    expect(h.cancelBuildSession).toHaveBeenCalledWith("d1", { keepProvisioned: true });
    expect(h.executeCleanup).toHaveBeenCalled();
  });

  it("ignores recordOnly for a cloud project — Oblien resources must be reclaimed", async () => {
    h.project = projectFixture({ cloudWorkspaceId: "ws1" });

    await teardownProject(ctx, "p1", { force: false, recordOnly: true });

    expect(h.collectProjectManifest).toHaveBeenCalled();
    expect(h.removeProjectFromServerManifests).toHaveBeenCalled();
  });

  it("tears down normally when recordOnly is not requested", async () => {
    // One reachable resource so the cleanup executor actually runs — proof the
    // skips above come from recordOnly, not from an empty manifest.
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      resources: [{ type: "container", ref: "c1", label: "container c1" }],
    } as never);
    h.executeCleanup.mockResolvedValueOnce({ total: 1, succeeded: 1, failed: [] });

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(h.collectProjectManifest).toHaveBeenCalled();
    expect(h.executeCleanup).toHaveBeenCalled();
    expect(h.removeProjectFromServerManifests).toHaveBeenCalled();
    expect(stepOf(res.steps, "runtime_cleanup")?.status).toBe("ok");
  });
});

describe("teardownProject — deferred multi-target cleanup", () => {
  it("checkpoints a named volume before container cleanup so a failed retry cannot forget it", async () => {
    h.collectProjectManifest
      .mockResolvedValueOnce({
        projectId: "p1",
        organizationId: "org1",
        resources: [
          {
            type: "container",
            ref: "container-with-data",
            label: "container with data",
            runtime: { name: "docker" },
            targetKey: "local",
            runtimeMode: "docker",
          },
          {
            type: "volume",
            ref: "app-data",
            label: "deployment volume app-data",
            runtime: { name: "docker" },
            targetKey: "local",
            runtimeMode: "docker",
          },
        ],
      } as never)
      // The container is gone on retry, so its mount inventory is gone too.
      .mockResolvedValueOnce({
        projectId: "p1",
        organizationId: "org1",
        resources: [],
      } as never);
    h.executeCleanup.mockResolvedValueOnce({
      total: 2,
      succeeded: 1,
      failed: [
        {
          type: "volume",
          ref: "app-data",
          label: "deployment volume app-data",
          error: "volume removal failed",
        },
      ],
    } as never);

    const first = await teardownProject(ctx, "p1", { force: false, wipeVolumes: true });
    const second = await teardownProject(ctx, "p1", { force: false, wipeVolumes: true });

    expect(first.rowDeleted).toBe(false);
    expect(second.rowDeleted).toBe(true);
    expect(h.orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        resourceType: "volume",
        ref: "app-data",
        targetKey: "local",
      }),
    );
    expect(h.orphanCreate.mock.invocationCallOrder[0]).toBeLessThan(
      h.executeCleanup.mock.invocationCallOrder[0]!,
    );
    // The checkpoint survives the failed first pass and the row deletion on the
    // second; GC can now remove the forgotten volume idempotently.
    expect(h.orphanDelete).not.toHaveBeenCalledWith("orphan-created");
  });

  it("records every known route on an unreachable historical target", async () => {
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      organizationId: "org1",
      resources: [
        {
          type: "unreachable",
          deferredResourceType: "project_target_sweep",
          ref: "p1",
          label: "remote target sweep",
          runtime: null,
          serverId: "server-old",
          targetKey: "server:server-old",
          runtimeMode: "docker",
          payload: {
            slug: "app",
            wipeVolumes: true,
            containerIds: ["container-remote"],
            imageRefs: [],
            artifactRefs: [],
            volumeNames: [],
          },
        },
        {
          type: "route",
          ref: "app.example.com",
          label: "route app.example.com",
          runtime: null,
        },
      ],
      routeContexts: [],
      unreachableRouteTargets: [{ serverId: "server-old", runtimeMode: "docker" }],
    } as never);
    h.executeCleanup.mockResolvedValueOnce({ total: 1, succeeded: 1, failed: [] });

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(true);
    expect(h.orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-old",
        targetKey: "server:server-old",
        resourceType: "project_target_sweep",
        ref: "p1",
        runtimeMode: "docker",
        payload: {
          slug: "app",
          wipeVolumes: true,
          containerIds: ["container-remote"],
          imageRefs: [],
          artifactRefs: [],
          volumeNames: [],
        },
      }),
    );
    expect(h.orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-old",
        resourceType: "route",
        ref: "app.example.com",
        runtimeMode: "docker",
      }),
    );
  });

  it("force-orphans each resource on its own historical target", async () => {
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      organizationId: "org1",
      resources: [
        {
          type: "container",
          ref: "container-a",
          label: "container a",
          runtime: { name: "docker" },
          serverId: "server-a",
          runtimeMode: "docker",
        },
        {
          type: "artifact",
          ref: "/srv/releases/b",
          label: "artifact b",
          runtime: { name: "bare" },
          serverId: "server-b",
          runtimeMode: "bare",
        },
        {
          type: "route",
          ref: "app.example.com",
          label: "route app.example.com",
          runtime: null,
        },
      ],
      routeContexts: [
        {
          key: "host-c",
          serverId: "server-c",
          runtimeMode: "docker",
          routing: {},
          hostPortTarget: {},
          edgeProxy: {},
        },
      ],
      unreachableRouteTargets: [{ serverId: "server-d", runtimeMode: "bare" }],
    } as never);

    const res = await teardownProject(ctx, "p1", { force: false, forceOrphan: true });

    expect(res.rowDeleted).toBe(true);
    const created = h.orphanCreate.mock.calls.map(([row]) => row);
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "container-a",
          serverId: "server-a",
          runtimeMode: "docker",
        }),
        expect.objectContaining({
          ref: "/srv/releases/b",
          serverId: "server-b",
          runtimeMode: "bare",
        }),
        expect.objectContaining({
          resourceType: "route",
          ref: "app.example.com",
          serverId: "server-c",
        }),
        expect.objectContaining({
          resourceType: "route",
          ref: "app.example.com",
          serverId: "server-d",
        }),
      ]),
    );
    expect(h.disposeManifestRuntimes).toHaveBeenCalledOnce();
    expect(h.executeCleanup).not.toHaveBeenCalled();
  });

  it("force-orphans host-port claims even when the project has no hostname route", async () => {
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      organizationId: "org1",
      resources: [],
      routeContexts: [
        {
          key: "host:claim-target",
          serverId: "server-claims",
          runtimeMode: "docker",
          routing: {},
          hostPortTarget: {},
          edgeProxy: {},
        },
      ],
    } as never);

    const res = await teardownProject(ctx, "p1", { force: false, forceOrphan: true });

    expect(res.rowDeleted).toBe(true);
    expect(h.orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-claims",
        resourceType: "host_port_claims",
        ref: "host:claim-target",
        runtimeMode: "docker",
      }),
    );
    expect(h.executeCleanup).not.toHaveBeenCalled();
  });

  it("keeps the project row when durable orphan tracking fails", async () => {
    h.collectProjectManifest.mockResolvedValueOnce({
      projectId: "p1",
      organizationId: "org1",
      resources: [
        {
          type: "unreachable",
          ref: "container-remote",
          label: "remote container",
          runtime: null,
          serverId: "server-old",
          runtimeMode: "docker",
        },
        {
          type: "route",
          ref: "app.example.com",
          label: "route app.example.com",
          runtime: null,
        },
      ],
      routeContexts: [],
      unreachableRouteTargets: [{ serverId: "server-old", runtimeMode: "docker" }],
    } as never);
    h.executeCleanup.mockResolvedValueOnce({ total: 1, succeeded: 1, failed: [] });
    h.orphanCreate
      .mockResolvedValueOnce({ id: "tracked-before-failure" })
      .mockRejectedValueOnce(new Error("database unavailable"));

    const res = await teardownProject(ctx, "p1", { force: false });

    expect(res.rowDeleted).toBe(false);
    expect(stepOf(res.steps, "persist_orphans")).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("database unavailable"),
      }),
    );
    expect(h.deleteHard).not.toHaveBeenCalled();
    expect(h.orphanDelete).toHaveBeenCalledWith("tracked-before-failure");
    expect(h.clearDeletionInProgress).toHaveBeenCalledWith("p1");
  });
});
