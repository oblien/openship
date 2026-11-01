import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cloud: false,
  activity: null as any,
  recoverBuild: vi.fn(),
  updateStatus: vi.fn(),
  current: null as any,
  session: null as any,
  project: null as any,
  admission: vi.fn(),
  collect: vi.fn(),
  cleanup: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      updateStatus: h.updateStatus,
      findById: async () => h.current,
      findBuildSessionByDeploymentId: async () => h.session,
      acknowledgeBuildExecutionFinished: h.acknowledge,
    },
    project: { findById: async () => h.project },
    cloudBuildActivity: { find: async () => h.activity },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/cloud-build-activity", () => ({
  recoverCloudBuildActivity: h.recoverBuild,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  tryWithCloudWorkspaceActivity: h.admission,
}));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", () => ({
  collectDeploymentManifest: h.collect,
  executeCleanup: h.cleanup,
}));

import { recoverManagedDeploymentExecution } from "@repo/platform/engine/modules/deployments/deployment-recovery";

const project = {
  id: "project",
  organizationId: "org",
  serverId: "server",
  workspaceId: "subscription",
} as any;
beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = false;
  h.activity = null;
  h.recoverBuild.mockImplementation(async (_identity, cleanup) => {
    await cleanup({ activated: true });
    return true;
  });
  h.updateStatus.mockResolvedValue(true);
  h.current = {
    id: "deployment",
    projectId: project.id,
    organizationId: project.organizationId,
    status: "cancelled",
    meta: {
      deployTarget: "cloud",
      serverId: project.serverId,
      managedWorkspaceId: project.workspaceId,
    },
  };
  h.session = { id: "build", startedAt: new Date(), finishedAt: null };
  h.project = { ...project };
  h.admission.mockImplementation(async (_id, work) => work());
  h.collect.mockResolvedValue({ projectId: project.id, resources: [{ ref: "attempt-container" }] });
  h.cleanup.mockResolvedValue({ failed: [] });
});

describe("managed deployment completion after a controller restart", () => {
  it("recovers an interrupted shared build only after its exact execution is admitted", async () => {
    h.cloud = true;
    h.activity = { deploymentId: "deployment" };
    h.current.status = "building";
    await expect(
      recoverManagedDeploymentExecution(h.current, project, { recoverInterrupted: true }),
    ).resolves.toBe(true);
    expect(h.admission).not.toHaveBeenCalled();
    expect(h.recoverBuild).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: "deployment", workspaceId: "subscription" }),
      expect.any(Function),
      { onFinished: expect.any(Function) },
    );
    expect(h.updateStatus).toHaveBeenCalledWith(
      "deployment",
      "failed",
      expect.objectContaining({ errorCode: "DEPLOYMENT_INTERRUPTED" }),
    );
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.acknowledge).toHaveBeenCalledWith("build");
  });

  it("does not change a shared execution when its live owner still holds the lock", async () => {
    h.cloud = true;
    h.activity = {};
    h.current.status = "building";
    h.recoverBuild.mockResolvedValue(false);
    expect(
      await recoverManagedDeploymentExecution(h.current, project, { recoverInterrupted: true }),
    ).toBe(false);
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("recovers a never-activated reservation without touching the host", async () => {
    h.cloud = true;
    h.activity = { ownerToken: null };
    h.current.status = "building";
    h.recoverBuild.mockImplementation(async (_identity, cleanup) => {
      await cleanup({ activated: false });
      return true;
    });
    expect(
      await recoverManagedDeploymentExecution(h.current, project, { recoverInterrupted: true }),
    ).toBe(true);
    expect(h.updateStatus).toHaveBeenCalledOnce();
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).toHaveBeenCalledOnce();
  });

  it("retains a shared execution lease if artifact cleanup fails", async () => {
    h.cloud = true;
    h.activity = {};
    h.cleanup.mockResolvedValue({ failed: [{ ref: "artifact" }] });
    await expect(recoverManagedDeploymentExecution(h.current, project)).rejects.toMatchObject({
      code: "DEPLOYMENT_RECOVERY_PENDING",
    });
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("recovers cancellation under the exact server/project fence before acknowledging completion", async () => {
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(true);
    expect(h.admission).toHaveBeenCalledWith(
      project.workspaceId,
      expect.any(Function),
      "project:project",
    );
    expect(h.collect).toHaveBeenCalledWith(h.current, project, { protectRetained: true });
    expect(h.acknowledge).toHaveBeenCalledWith("build");
    expect(h.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      h.acknowledge.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves a live replica's worker alone", async () => {
    h.admission.mockResolvedValue(undefined);
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("does not close the deployment when a remote command's completion is unknown", async () => {
    h.admission.mockRejectedValue(new Error("remote command is still running"));
    await expect(recoverManagedDeploymentExecution(h.current, project)).rejects.toThrow(
      "still running",
    );
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("retains the lease when cleanup is incomplete", async () => {
    h.cleanup.mockResolvedValue({ failed: [{ ref: "attempt-container" }] });
    await expect(recoverManagedDeploymentExecution(h.current, project)).rejects.toMatchObject({
      code: "DEPLOYMENT_RECOVERY_PENDING",
    });
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it.each(["ready", "partial_failure", "reconciling", "no_changes"])(
    "preserves the recorded %s outcome and its live resources",
    async (status) => {
      h.current.status = status;
      await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(true);
      expect(h.current.status).toBe(status);
      expect(h.cleanup).not.toHaveBeenCalled();
      expect(h.acknowledge).toHaveBeenCalledWith("build");
    },
  );

  it("keeps the persisted record-only cancellation policy on retries", async () => {
    h.current.meta.cancellation = { keepProvisioned: true };
    await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(true);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.acknowledge).toHaveBeenCalledWith("build");
  });

  it.each(["queued", "building", "deploying"])(
    "does not recover an uncancelled %s deployment",
    async (status) => {
      h.current.status = status;
      await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
      expect(h.admission).not.toHaveBeenCalled();
    },
  );

  it.each(["projectId", "organizationId"])(
    "rejects a deployment with a different %s",
    async (key) => {
      h.current[key] = "other";
      await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
      expect(h.admission).not.toHaveBeenCalled();
    },
  );

  it.each(["serverId", "managedWorkspaceId"])(
    "does not recover under a different snapshotted %s",
    async (key) => {
      h.current.meta[key] = "other";
      await expect(recoverManagedDeploymentExecution(h.current, project)).resolves.toBe(false);
      expect(h.admission).not.toHaveBeenCalled();
    },
  );

  it("rechecks the outcome after acquiring the fence", async () => {
    const dep = { ...h.current };
    h.admission.mockImplementation(async (_id, work) => {
      h.current.status = "deploying";
      return work();
    });
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
