/**
 * Swarm rollback lives in its own file: it stubs `@repo/db` and `../build.service`
 * with a different shape than the container-restore suite next door, and vi.mock
 * is per-FILE — one registry cannot serve both.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findDeployment: vi.fn(),
  findProject: vi.fn(),
  getRevision: vi.fn(),
  triggerDeployment: vi.fn(),
  setArtifactRetainedAt: vi.fn(),
  listReadyOrderedDesc: vi.fn(),
  removeRevision: vi.fn(),
  getStack: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findById: mocks.findDeployment,
      setArtifactRetainedAt: mocks.setArtifactRetainedAt,
      listReadyOrderedDesc: mocks.listReadyOrderedDesc,
    },
    project: { findById: mocks.findProject },
    instanceSettings: { get: vi.fn() },
    swarmStack: {
      getRevisionInOrganization: mocks.getRevision,
      removeRevisionInOrganization: mocks.removeRevision,
      getForProjectInOrganization: mocks.getStack,
    },
  },
}));

vi.mock("../build.service", () => ({
  checkNoActiveBuild: vi.fn(),
  triggerDeployment: mocks.triggerDeployment,
}));

import { onDeploymentReady, prune, rollback } from "./rollback-orchestrator";

const target = {
  id: "dep-target",
  projectId: "project-a",
  organizationId: "org-a",
  branch: "main",
  commitSha: "newer-commit",
  commitMessage: "newer deployment",
  environment: "production",
  status: "ready",
  rollbackStrategy: "snapshot",
  artifactRetainedAt: new Date("2026-07-30T00:00:00.000Z"),
  envVars: { API_TOKEN: "enc1:snapshot" },
  runtimeRef: {
    kind: "swarm-stack",
    clusterId: "cluster-a",
    managerServerId: "server-a",
    stackName: "blog",
    revisionId: "swr-target",
  },
};

describe("Swarm rollback orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findDeployment.mockResolvedValue(target);
    mocks.findProject.mockResolvedValue({ id: "project-a", activeDeploymentId: "dep-active" });
    mocks.getRevision.mockResolvedValue({
      id: "swr-target",
      revision: 3,
      applyStatus: "ready",
      renderedYamlEnc: "enc1:retained",
      sourceCommitSha: "older-commit",
    });
    mocks.triggerDeployment.mockResolvedValue({
      deployment: { id: "dep-rollback", trigger: "rollback" },
    });
    mocks.setArtifactRetainedAt.mockResolvedValue(undefined);
    mocks.listReadyOrderedDesc.mockResolvedValue([]);
    mocks.removeRevision.mockResolvedValue(true);
    mocks.getStack.mockResolvedValue(undefined);
  });

  it("creates a new standard deployment bound to the selected immutable Swarm revision", async () => {
    await expect(rollback("dep-target")).resolves.toMatchObject({
      id: "dep-rollback",
      trigger: "rollback",
    });
    expect(mocks.getRevision).toHaveBeenCalledWith("swr-target", "org-a");
    const [context, input] = mocks.triggerDeployment.mock.calls[0]!;
    expect(context.organizationId).toBe("org-a");
    expect(context.sessionId).toBe("bg:swarm:rollback");
    expect(input).toEqual(
      expect.objectContaining({
        projectId: "project-a",
        trigger: "rollback",
        commitSha: "older-commit",
        forceAll: true,
        swarmRollback: {
          sourceDeploymentId: "dep-target",
          sourceRevisionId: "swr-target",
          environmentSnapshot: { API_TOKEN: "enc1:snapshot" },
        },
      }),
    );
  });

  it("blocks before scheduling when the retained Swarm revision is unavailable", async () => {
    mocks.getRevision.mockResolvedValue(undefined);
    await expect(rollback("dep-target")).rejects.toMatchObject({ code: "ROLLBACK_ARTIFACT_GONE" });
    expect(mocks.triggerDeployment).not.toHaveBeenCalled();
  });

  it("blocks an expired Swarm deployment even when its old revision row still exists", async () => {
    mocks.findDeployment.mockResolvedValue({ ...target, artifactRetainedAt: null });
    await expect(rollback("dep-target")).rejects.toMatchObject({ code: "ROLLBACK_ARTIFACT_GONE" });
    expect(mocks.getRevision).not.toHaveBeenCalled();
    expect(mocks.triggerDeployment).not.toHaveBeenCalled();
  });

  it("retains a stack revision without invoking a container archive", async () => {
    await onDeploymentReady({
      newDeployment: {
        ...target,
        id: "dep-new",
        runtimeRef: { ...target.runtimeRef, revisionId: "swr-new" },
      } as never,
      previousActive: target as never,
    });
    expect(mocks.setArtifactRetainedAt).toHaveBeenCalledWith("dep-target", expect.any(Date));
    expect(mocks.setArtifactRetainedAt).toHaveBeenCalledWith("dep-new", expect.any(Date));
  });

  it("purges an expired unpinned Swarm revision record before clearing rollbackability", async () => {
    const newest = {
      ...target,
      id: "dep-new",
      runtimeRef: { ...target.runtimeRef, revisionId: "swr-new" },
    };
    mocks.findProject.mockResolvedValue({
      id: "project-a",
      organizationId: "org-a",
      activeDeploymentId: "dep-new",
      rollbackWindow: 0,
    });
    mocks.listReadyOrderedDesc.mockResolvedValue([newest, target]);
    await expect(prune("project-a")).resolves.toEqual({ purged: 1 });
    expect(mocks.removeRevision).toHaveBeenCalledWith("swr-target", "org-a");
    expect(mocks.setArtifactRetainedAt).toHaveBeenCalledWith("dep-target", null);
  });
});
