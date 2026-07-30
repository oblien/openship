import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findDeployment: vi.fn(),
  findProject: vi.fn(),
  getRevision: vi.fn(),
  triggerDeployment: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: { findById: mocks.findDeployment },
    project: { findById: mocks.findProject },
    swarmStack: { getRevisionInOrganization: mocks.getRevision },
  },
}));

vi.mock("../build.service", () => ({
  checkNoActiveBuild: vi.fn(),
  triggerDeployment: mocks.triggerDeployment,
}));

import { rollback } from "./rollback-orchestrator";

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
    mocks.triggerDeployment.mockResolvedValue({ deployment: { id: "dep-rollback", trigger: "rollback" } });
  });

  it("creates a new standard deployment bound to the selected immutable Swarm revision", async () => {
    await expect(rollback("dep-target")).resolves.toMatchObject({ id: "dep-rollback", trigger: "rollback" });
    expect(mocks.getRevision).toHaveBeenCalledWith("swr-target", "org-a");
    const [context, input] = mocks.triggerDeployment.mock.calls[0]!;
    expect(context.organizationId).toBe("org-a");
    expect(context.sessionId).toBe("bg:swarm:rollback");
    expect(input).toEqual(expect.objectContaining({
        projectId: "project-a",
        trigger: "rollback",
        commitSha: "older-commit",
        forceAll: true,
        swarmRollback: {
          sourceDeploymentId: "dep-target",
          sourceRevisionId: "swr-target",
          environmentSnapshot: { API_TOKEN: "enc1:snapshot" },
        },
      }));
  });

  it("blocks before scheduling when the retained Swarm revision is unavailable", async () => {
    mocks.getRevision.mockResolvedValue(undefined);
    await expect(rollback("dep-target")).rejects.toMatchObject({ code: "ROLLBACK_ARTIFACT_GONE" });
    expect(mocks.triggerDeployment).not.toHaveBeenCalled();
  });
});
