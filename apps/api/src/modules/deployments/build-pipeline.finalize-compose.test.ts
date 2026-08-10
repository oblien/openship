import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment, Project } from "@repo/db";
import type { BuildLogger } from "@repo/adapters";

const findById = vi.fn();
const listByDeployment = vi.fn();
const onDeploymentReady = vi.fn();
const rollupDeploymentStatus = vi.fn();
const setDeploymentStatus = vi.fn();

vi.mock("@repo/db", () => ({
  repos: {
    deployment: { findById: (...args: unknown[]) => findById(...args) },
    serviceDeployment: {
      listByDeployment: (...args: unknown[]) => listByDeployment(...args),
    },
  },
}));

vi.mock("../../lib/controller-helpers", () => ({ platform: vi.fn() }));

vi.mock("../../lib/openship-manifest-sync", () => ({
  syncProjectToServerManifest: vi.fn(),
}));

vi.mock("../github/clone-auth", () => ({ resolveBuildGitToken: vi.fn() }));

vi.mock("../../lib/git-forwarding", () => ({ openDeployRelay: vi.fn() }));

vi.mock("./service-checks", () => ({
  preCreateServiceDeployments: vi.fn(),
  emitServiceCheckRun: vi.fn().mockResolvedValue(undefined),
  emitInitialServiceChecks: vi.fn(),
  rollupDeploymentStatus: (...args: unknown[]) => rollupDeploymentStatus(...args),
}));

vi.mock("./deployment-lifecycle", () => ({
  onFailure: vi.fn(),
  onSuccess: vi.fn(),
  onCancelled: vi.fn(),
  setDeploymentStatus: (...args: unknown[]) => setDeploymentStatus(...args),
}));

vi.mock("./rollback", () => ({
  onDeploymentReady: (...args: unknown[]) => onDeploymentReady(...args),
}));

import { finalizeComposeDeploy } from "./build-pipeline";

const asDeployment = (deployment: Partial<Deployment>) => deployment as Deployment;
const asProject = (project: Partial<Project>) => project as Project;
const logger = {} as BuildLogger;
const previousDeploymentId = "previous-deployment";
const project = asProject({ id: "project-1", activeDeploymentId: previousDeploymentId });

function deploymentWithStatus(status: Deployment["status"]): Deployment {
  return asDeployment({
    id: "new-deployment",
    projectId: project.id,
    rollbackStrategy: "snapshot",
    status,
  });
}

describe("finalizeComposeDeploy", () => {
  beforeEach(() => {
    findById.mockReset();
    listByDeployment.mockReset();
    onDeploymentReady.mockReset();
    rollupDeploymentStatus.mockReset();
    setDeploymentStatus.mockReset();
    listByDeployment.mockResolvedValue([]);
    rollupDeploymentStatus.mockReturnValue("ready");
    setDeploymentStatus.mockResolvedValue(undefined);
  });

  it.each(["failed", "cancelled", "reconciling"] as const)(
    "does not retire the prior release when the compose deployment is %s",
    async (status) => {
      const deployment = deploymentWithStatus(status);
      findById.mockResolvedValue(deployment);

      await finalizeComposeDeploy({ project, dep: deployment, logger });

      expect(onDeploymentReady).not.toHaveBeenCalled();
    },
  );

  it("does not retire the prior release when compose rollup records a failure", async () => {
    let deployment = deploymentWithStatus("ready");
    findById.mockResolvedValue(deployment);
    rollupDeploymentStatus.mockReturnValue("failed");
    setDeploymentStatus.mockImplementation(async (_id, status) => {
      deployment = { ...deployment, status };
      findById.mockResolvedValue(deployment);
    });

    await finalizeComposeDeploy({ project, dep: deployment, logger });

    expect(onDeploymentReady).not.toHaveBeenCalled();
  });

  it("retires the prior release when the compose deployment is ready", async () => {
    const deployment = deploymentWithStatus("ready");
    const previous = asDeployment({ id: previousDeploymentId, projectId: project.id });
    findById.mockImplementation(async (id: string) => (id === previous.id ? previous : deployment));

    await finalizeComposeDeploy({ project, dep: deployment, logger });

    expect(onDeploymentReady).toHaveBeenCalledWith({
      newDeployment: deployment,
      previousActive: previous,
    });
  });

  it("retires the prior release when the compose deployment partially failed", async () => {
    const deployment = deploymentWithStatus("partial_failure");
    const previous = asDeployment({ id: previousDeploymentId, projectId: project.id });
    findById.mockImplementation(async (id: string) => (id === previous.id ? previous : deployment));

    await finalizeComposeDeploy({ project, dep: deployment, logger });

    expect(onDeploymentReady).toHaveBeenCalledWith({
      newDeployment: deployment,
      previousActive: previous,
    });
  });
});
