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
 *   • no webmail teardown  → no on-disk branding/mail-state wipe
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
  orphanCreate: vi.fn(async () => {}),

  collectProjectManifest: vi.fn(async () => ({ projectId: "p1", resources: [] })),
  executeCleanup: vi.fn(async () => ({ total: 0, succeeded: 0, failed: [] })),
  removeProjectFromServerManifests: vi.fn(async () => {}),
  cancelBuildSession: vi.fn(async () => ({ success: true })),
  deleteGitHubWebhook: vi.fn(async () => {}),
  cleanupWebmailInstall: vi.fn(async () => {}),
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
      listByProject: vi.fn(async () => ({
        rows: h.listByProjectCalls++ === 0 ? h.activeDeployments : [],
      })),
    },
    backupRun: { listInFlightByProject: vi.fn(async () => []) },
    backupRestore: { listInFlightByProject: vi.fn(async () => []) },
    orphanedResource: { create: h.orphanCreate },
    projectConnection: { listBySource: vi.fn(async () => h.consumers) },
  },
}));

vi.mock("./project-connection.service", () => ({
  unlinkConsumersOfSource: h.unlinkConsumersOfSource,
}));

vi.mock("./project-cleanup.service", () => ({
  collectProjectManifest: h.collectProjectManifest,
  executeCleanup: h.executeCleanup,
}));
vi.mock("../../lib/openship-manifest-sync", () => ({
  removeProjectFromServerManifests: h.removeProjectFromServerManifests,
}));
vi.mock("../deployments/build.service", () => ({
  cancelBuildSession: h.cancelBuildSession,
}));
vi.mock("../github/github.service", () => ({ deleteWebhook: h.deleteGitHubWebhook }));
vi.mock("../mail/webmail/webmail-project.service", () => ({
  cleanupWebmailInstall: h.cleanupWebmailInstall,
  mailServerIdFromWebmailSlug: () => "mail-1",
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
  h.listByProjectCalls = 0;
  h.consumers = [];
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

  it("keeps a webmail project's on-disk install even though the row drops", async () => {
    h.project = projectFixture({ framework: "webmail", slug: "webmail-mail-1" });

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

    await teardownProject(ctx, "p1", { force: true, recordOnly: false });

    expect(h.cancelBuildSession).toHaveBeenCalledWith("d1", { keepProvisioned: false });
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
