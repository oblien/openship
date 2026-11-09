import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment, Project } from "@repo/db";

const h = vi.hoisted(() => ({
  session: null as any,
  settle: vi.fn(),
  live: vi.fn(),
  list: vi.fn(),
  find: vi.fn(),
  owner: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findBuildSessionByDeploymentId: async () => h.session,
      recoverFencedBuildExecution: h.settle,
      hasLiveBuildExecution: h.live,
      listUnfinishedFencedBuildExecutions: h.list,
      findById: h.find,
    },
    project: { findByIdInOrganization: h.owner },
  },
}));
vi.mock("@repo/core/diagnostics", () => ({ diagnostics: { error: h.diagnostic } }));
vi.mock("../src/engine/config/env", () => ({ env: { CLOUD_MODE: true } }));
vi.mock("../src/engine/lib/cloud-workspace-lock", () => ({
  tryWithCloudWorkspaceActivity: vi.fn(),
}));
vi.mock("../src/engine/lib/cloud-build-activity", () => ({ recoverCloudBuildActivity: vi.fn() }));
vi.mock("../src/engine/modules/projects/project-cleanup.service", () => ({
  collectDeploymentManifest: vi.fn(),
  executeCleanup: vi.fn(),
}));
vi.mock("../src/engine/lib/provision-lock", async () => {
  const { withKeyedMutex, tryWithKeyedMutex } = await import("@repo/core");
  return {
    createProvisionLock: (key: string) => ({
      run: (work: () => Promise<unknown>) => withKeyedMutex(key, work),
    }),
    tryWithProvisionLock: (key: string, work: () => Promise<unknown>) =>
      tryWithKeyedMutex(key, work),
  };
});
import {
  recoverDeploymentExecution,
  recoverUnfinishedDeploymentExecutions,
} from "../src/engine/modules/deployments/deployment-recovery";
import {
  withDeploymentExecutionOwnership,
  tryWithDeploymentExecutionOwnership,
  runOutsideDeploymentExecutionOwnership,
} from "../src/engine/lib/deployment-execution-ownership";

const project = {
  id: "project",
  organizationId: "org",
  serverId: "ssh-server",
  workspaceId: null,
} as Project;
const deployment = {
  id: "deployment",
  projectId: project.id,
  organizationId: project.organizationId,
  status: "cancelled",
} as Deployment;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.session = { id: "build", executionFenced: true, startedAt: new Date(0), finishedAt: null };
  h.settle.mockResolvedValue(true);
  h.live.mockResolvedValue(false);
  h.list.mockResolvedValue([]);
  h.find.mockResolvedValue(deployment);
  h.owner.mockResolvedValue(project);
});

describe("SSH deployment worker ownership", () => {
  it("does not clear a cancelled worker still performing cleanup, regardless of elapsed time", async () => {
    const entered = deferred();
    const stopping = deferred();
    const worker = withDeploymentExecutionOwnership(deployment.id, async () => {
      entered.resolve();
      await stopping.promise;
    });
    await entered.promise;
    try {
      expect(await recoverDeploymentExecution(deployment, project)).toBe(false);
      expect(h.settle).not.toHaveBeenCalled();
      expect(h.session.finishedAt).toBeNull();
    } finally {
      stopping.resolve();
      await worker;
    }
    // The worker is gone without acknowledging its durable session.
    expect(await recoverDeploymentExecution(deployment, project)).toBe(true);
    expect(h.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: deployment.id,
        buildSessionId: "build",
        organizationId: "org",
      }),
    );
  });

  it.each([
    { executionFenced: false },
    { executionFenced: undefined },
    { startedAt: null },
    { finishedAt: new Date() },
  ])("keeps an untracked or already-settled worker untouched: %j", async (changes) => {
    h.session = { ...h.session, ...changes };
    expect(await recoverDeploymentExecution(deployment, project)).toBe(false);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it.each(["projectId", "organizationId"] as const)("rejects a mismatched %s", async (field) => {
    expect(await recoverDeploymentExecution({ ...deployment, [field]: "other" }, project)).toBe(
      false,
    );
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("does not inherit runtime ownership into a recovery callback", async () => {
    await expect(
      tryWithDeploymentExecutionOwnership(deployment.id, () =>
        withDeploymentExecutionOwnership(deployment.id, async () => {}),
      ),
    ).rejects.toMatchObject({ code: "CLOUD_BUILD_EXECUTION_OWNERSHIP_CHANGED" });
    // Failure releases the fence; a real worker can subsequently enter.
    await expect(
      withDeploymentExecutionOwnership(deployment.id, async () => "entered"),
    ).resolves.toBe("entered");
  });

  it("allows same-worker nesting but requires detached work to acquire its own ownership", async () => {
    await withDeploymentExecutionOwnership(deployment.id, async () => {
      await expect(
        withDeploymentExecutionOwnership(deployment.id, async () => "nested"),
      ).resolves.toBe("nested");
      expect(
        await runOutsideDeploymentExecutionOwnership(() =>
          recoverDeploymentExecution(deployment, project),
        ),
      ).toBe(false);
    });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("fails closed when the database recovery write fails", async () => {
    h.settle.mockRejectedValue(new Error("database unavailable"));
    await expect(recoverDeploymentExecution(deployment, project)).rejects.toThrow(
      "database unavailable",
    );
    expect(h.session.finishedAt).toBeNull();
    h.settle.mockResolvedValue(true);
    expect(await recoverDeploymentExecution(deployment, project)).toBe(true);
  });

  it("does not report cancellation complete while another session is still unfinished", async () => {
    h.live.mockResolvedValue(true);
    expect(await recoverDeploymentExecution(deployment, project)).toBe(false);
    expect(h.settle).toHaveBeenCalledOnce();
  });
});

describe("scheduled orphan recovery", () => {
  it("recovers the exact older session even when the deployment's latest session already finished", async () => {
    h.session.finishedAt = new Date();
    h.list.mockResolvedValueOnce([{ deploymentId: deployment.id, projectId: project.id, organizationId: "org", buildSessionId: "older-build" }]);
    expect(await recoverUnfinishedDeploymentExecutions()).toBe(1);
    expect(h.settle).toHaveBeenCalledWith({ deploymentId: deployment.id, projectId: project.id, organizationId: "org", buildSessionId: "older-build", recoverInterrupted: true });
  });

  it("continues with other projects after one failed recovery", async () => {
    h.list.mockResolvedValueOnce([
      {
        deploymentId: "first",
        projectId: project.id,
        organizationId: "org",
        buildSessionId: "first-build",
      },
      {
        deploymentId: "second",
        projectId: project.id,
        organizationId: "org",
        buildSessionId: "second-build",
      },
    ]);
    h.settle.mockRejectedValueOnce(new Error("retry this row later")).mockResolvedValueOnce(true);
    expect(await recoverUnfinishedDeploymentExecutions()).toBe(1);
    expect(h.diagnostic).toHaveBeenCalledOnce();
    expect(h.settle).toHaveBeenCalledTimes(2);
  });

  it("uses the last session ID to page past live workers instead of starving later orphans", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      deploymentId: `dep-${index}`,
      projectId: project.id,
      organizationId: "org",
      buildSessionId: `build-${index}`,
    }));
    h.list
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ ...firstPage[0], buildSessionId: "last-build" }]);
    h.settle.mockResolvedValue(false);
    expect(await recoverUnfinishedDeploymentExecutions()).toBe(0);
    expect(h.list.mock.calls).toEqual([[undefined], ["build-199"]]);
    expect(h.settle).toHaveBeenCalledTimes(201);
  });
});
