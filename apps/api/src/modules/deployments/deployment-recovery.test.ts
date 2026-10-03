import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  current: null as any,
  session: null as any,
  project: null as any,
  admission: vi.fn(),
  collect: vi.fn(),
  cleanup: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { deployment: {
  findById: async () => h.current,
  findBuildSessionByDeploymentId: async () => h.session,
  acknowledgeBuildExecutionFinished: h.acknowledge,
}, project: { findById: async () => h.project } } }));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({ tryWithCloudWorkspaceActivity: h.admission }));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", () => ({
  collectDeploymentManifest: h.collect, executeCleanup: h.cleanup,
}));

import { recoverManagedDeploymentExecution } from "@repo/platform/engine/modules/deployments/deployment-recovery";

const project = { id: "project", organizationId: "org", serverId: "server", workspaceId: "subscription" } as any;
beforeEach(() => {
  vi.resetAllMocks();
  h.current = { id: "deployment", projectId: project.id, organizationId: project.organizationId,
    status: "cancelled", meta: { deployTarget: "cloud", serverId: project.serverId, managedWorkspaceId: project.workspaceId } };
  h.session = { id: "build", startedAt: new Date(), finishedAt: null };
  h.project = { ...project };
  h.admission.mockImplementation(async (_id, work) => work());
  h.collect.mockResolvedValue({ projectId: project.id, resources: [{ ref: "attempt-container" }] });
  h.cleanup.mockResolvedValue({ failed: [] });
});

describe("managed deployment completion after a controller restart", () => {
  it("recovers cancellation under the exact server/project fence before acknowledging completion", async () => {
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(true);
    expect(h.admission).toHaveBeenCalledWith(project.workspaceId, expect.any(Function), "project:project");
    expect(h.collect).toHaveBeenCalledWith(h.current, project, { protectRetained: true });
    expect(h.acknowledge).toHaveBeenCalledWith("build");
    expect(h.cleanup.mock.invocationCallOrder[0]).toBeLessThan(h.acknowledge.mock.invocationCallOrder[0]!);
  });

  it("leaves a live replica's worker alone", async () => {
    h.admission.mockResolvedValue(undefined);
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("does not close the deployment when a remote command's completion is unknown", async () => {
    h.admission.mockRejectedValue(new Error("remote command is still running"));
    await expect(recoverManagedDeploymentExecution(h.current, project)).rejects.toThrow("still running");
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("retains the lease when cleanup is incomplete", async () => {
    h.cleanup.mockResolvedValue({ failed: [{ ref: "attempt-container" }] });
    await expect(recoverManagedDeploymentExecution(h.current, project)).rejects.toMatchObject({ code: "DEPLOYMENT_RECOVERY_PENDING" });
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it.each(["ready", "partial_failure", "reconciling", "no_changes"])("preserves the recorded %s outcome and its live resources", async status => {
    h.current.status = status;
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(true);
    expect(h.current.status).toBe(status);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).toHaveBeenCalledWith("build");
  });

  it("keeps the persisted record-only cancellation policy on retries", async () => {
    h.current.meta.cancellation = { keepProvisioned: true };
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(true);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).toHaveBeenCalledWith("build");
  });

  it.each(["queued", "building", "deploying"])("does not recover an uncancelled %s deployment", async status => {
    h.current.status = status;
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
    expect(h.admission).not.toHaveBeenCalled();
  });

  it.each(["projectId", "organizationId"])("rejects a deployment with a different %s", async key => {
    h.current[key] = "other";
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
    expect(h.admission).not.toHaveBeenCalled();
  });

  it.each(["serverId", "managedWorkspaceId"])("does not recover under a different snapshotted %s", async key => {
    h.current.meta[key] = "other";
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
    expect(h.admission).not.toHaveBeenCalled();
  });

  it("rechecks the outcome after acquiring the fence", async () => {
    const dep = { ...h.current };
    h.admission.mockImplementation(async (_id, work) => { h.current.status = "deploying"; return work(); });
    await expect(recoverManagedDeploymentExecution(dep, project)).resolves.toBe(false);
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("does not follow a project moved to another server before recovery acquires the fence", async () => {
    h.project.workspaceId = "another-subscription";
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });
});
