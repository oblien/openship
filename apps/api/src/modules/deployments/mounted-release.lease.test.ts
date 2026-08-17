import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findProject: vi.fn(),
  updateStatus: vi.fn(),
  setReleasePhase: vi.fn(),
  setActiveReleaseDeployment: vi.fn(),
  setActiveReleaseDeploymentIfReady: vi.fn(),
  claimDeployLease: vi.fn(),
  releaseDeployLease: vi.fn(),
  listWithDeployLease: vi.fn(),
  listInFlight: vi.fn(),
  findInFlightByProject: vi.fn(),
  create: vi.fn(),
  createBuildSession: vi.fn(),
  findBuildSessionByDeploymentId: vi.fn(),
  persistBuildSessionLogs: vi.fn(),
  finishBuildSession: vi.fn(),
  deleteDeployment: vi.fn(),
  findReadyVersionByCommit: vi.fn(),
  getNextReadyVersion: vi.fn(),
  listReadyOrderedDesc: vi.fn(),
  listByProject: vi.fn(),
  supersedeReconciling: vi.fn(),
  supersedePendingDecisions: vi.fn(),
  listServices: vi.fn(),
  exec: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  resolveServerExecutor: vi.fn(),
  resolveBuildGitToken: vi.fn(),
  assembleGitClone: vi.fn(),
  livePrimaryContainerId: vi.fn(),
  assertGitHubRepoAccess: vi.fn(),
  appendLog: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repos: {
    deployment: {
      findById: mocks.findById,
      updateStatus: mocks.updateStatus,
      setReleasePhase: mocks.setReleasePhase,
      create: mocks.create,
      createBuildSession: mocks.createBuildSession,
      findBuildSessionByDeploymentId: mocks.findBuildSessionByDeploymentId,
      persistBuildSessionLogs: mocks.persistBuildSessionLogs,
      finishBuildSession: mocks.finishBuildSession,
      deleteDeployment: mocks.deleteDeployment,
      findReadyVersionByCommit: mocks.findReadyVersionByCommit,
      getNextReadyVersion: mocks.getNextReadyVersion,
      listReadyOrderedDesc: mocks.listReadyOrderedDesc,
      listByProject: mocks.listByProject,
      findInFlightByProject: mocks.findInFlightByProject,
      listInFlight: mocks.listInFlight,
      supersedeReconciling: mocks.supersedeReconciling,
      supersedePendingDecisions: mocks.supersedePendingDecisions,
    },
    project: {
      findById: mocks.findProject,
      setActiveReleaseDeployment: mocks.setActiveReleaseDeployment,
      setActiveReleaseDeploymentIfReady: mocks.setActiveReleaseDeploymentIfReady,
      claimDeployLease: mocks.claimDeployLease,
      releaseDeployLease: mocks.releaseDeployLease,
      listWithDeployLease: mocks.listWithDeployLease,
    },
    service: { listByProject: mocks.listServices },
  },
}));

vi.mock("../../lib/deployment-runtime", () => ({
  resolveServerExecutor: mocks.resolveServerExecutor,
}));

vi.mock("../github/clone-auth", () => ({
  resolveBuildGitToken: mocks.resolveBuildGitToken,
}));

vi.mock("../github/github-access", () => ({
  assertGitHubRepoAccess: mocks.assertGitHubRepoAccess,
}));

vi.mock("../services/service-container", () => ({
  livePrimaryContainerId: mocks.livePrimaryContainerId,
  liveContainerIdForService: vi.fn(),
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assembleGitClone: mocks.assembleGitClone,
}));

vi.mock("./session-manager", () => ({
  appendLog: mocks.appendLog,
  updateStatus: mocks.updateSession,
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  broadcastServiceStatus: vi.fn(),
}));

vi.mock("../../lib/controller-helpers", () => ({
  assertResourceInOrg: (resource: unknown) => resource,
  platform: () => ({ runtime: { cancelBuild: vi.fn(async () => {}) } }),
}));

vi.mock("../projects/project-cleanup.service", () => ({
  collectDeploymentManifest: vi.fn(async () => ({ projectId: "p1", resources: [] })),
  executeCleanup: vi.fn(async () => {}),
}));

vi.mock("../../lib/plan-guard", () => ({
  assertPlanAllowsDeployShape: vi.fn(async () => {}),
  assertBuildMinutesAvailable: vi.fn(async () => {}),
}));

import { ForbiddenError } from "@repo/core";
import { cancelBuildSession, checkNoActiveBuild, createQueuedDeployment } from "./build.service";
import { beginDeployRun, endDeployRun, revertIfIncompleteActivation } from "./deploy-lease";
import {
  failCleanMountedRelease,
  findActiveSameShaRelease,
  recoverInterruptedDeployments,
  runMountedRelease,
  triggerMountedRelease,
} from "./mounted-release.service";

const project = {
  id: "p1",
  organizationId: "org1",
  name: "app",
  slug: "app",
  gitUrl: "https://github.com/acme/app.git",
  gitBranch: "main",
  gitOwner: "acme",
  gitRepo: "app",
  framework: "laravel",
  serverId: "srv1",
  port: 3000,
  activeDeploymentId: "dep_runtime",
  activeReleaseDeploymentId: null as string | null,
  mountedRelease: {
    enabled: true,
    containerPath: "/srv/app",
    buildMode: "prebuilt",
  },
};

const dep = {
  id: "dep_rel",
  projectId: "p1",
  organizationId: "org1",
  branch: "main",
  commitSha: null,
  status: "queued",
  releasePhase: null as string | null,
  meta: { deploymentLane: "release" },
};

const ctx = { organizationId: "org1", userId: "u1" } as never;

function executor() {
  return {
    exec: mocks.exec,
    rm: mocks.rm,
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
  };
}

describe("mounted release lease, cancel, and recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findProject.mockImplementation(async (id: string) =>
      id === "p1" ? { ...project } : undefined,
    );
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_runtime") {
        return { id: "dep_runtime", status: "ready", meta: { serverId: "srv1" } };
      }
      if (id === "dep_rel") return { ...dep, status: "building" };
      return null;
    });
    mocks.updateStatus.mockResolvedValue(true);
    mocks.setReleasePhase.mockResolvedValue(true);
    mocks.setActiveReleaseDeploymentIfReady.mockResolvedValue(true);
    mocks.claimDeployLease.mockResolvedValue(true);
    mocks.releaseDeployLease.mockResolvedValue(true);
    mocks.listWithDeployLease.mockResolvedValue([]);
    mocks.listInFlight.mockResolvedValue([]);
    mocks.findInFlightByProject.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ ...dep });
    mocks.createBuildSession.mockResolvedValue({ id: "bld_1" });
    mocks.deleteDeployment.mockResolvedValue(undefined);
    mocks.findBuildSessionByDeploymentId.mockResolvedValue({ id: "bld_1" });
    mocks.persistBuildSessionLogs.mockResolvedValue(undefined);
    mocks.finishBuildSession.mockResolvedValue(undefined);
    mocks.findReadyVersionByCommit.mockResolvedValue(null);
    mocks.getNextReadyVersion.mockResolvedValue(2);
    mocks.listReadyOrderedDesc.mockResolvedValue([]);
    mocks.supersedeReconciling.mockResolvedValue(undefined);
    mocks.supersedePendingDecisions.mockResolvedValue(undefined);
    mocks.listServices.mockResolvedValue([]);
    mocks.livePrimaryContainerId.mockResolvedValue("ctr_1");
    mocks.resolveServerExecutor.mockResolvedValue({ executor: executor() });
    mocks.resolveBuildGitToken.mockResolvedValue({ token: "tok" });
    mocks.assembleGitClone.mockReturnValue({ gitEnv: "", credFlag: "", cloneUrl: "https://git" });
    mocks.assertGitHubRepoAccess.mockResolvedValue(undefined);
    mocks.getSession.mockReturnValue({ logs: [] });
    mocks.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes("rev-parse")) return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      if (cmd.includes("readlink")) return "releases/dep_old\n";
      return "";
    });
    mocks.rm.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("returns the already-active release for a same-SHA code deploy", async () => {
    const live = {
      id: "dep_live",
      status: "ready",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    mocks.findProject.mockResolvedValue({ ...project, activeReleaseDeploymentId: "dep_live" });
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_live") return live;
      if (id === "dep_runtime") return { id: "dep_runtime", status: "ready", meta: {} };
      return null;
    });

    const result = await triggerMountedRelease(ctx, "p1", {
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.id).toBe("dep_live");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.setActiveReleaseDeployment).not.toHaveBeenCalled();
  });

  it("findActiveSameShaRelease matches abbreviated SHAs", async () => {
    mocks.findById.mockResolvedValue({
      id: "dep_live",
      status: "ready",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await expect(
      findActiveSameShaRelease(
        { activeReleaseDeploymentId: "dep_live" },
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).resolves.toMatchObject({ id: "dep_live" });
  });

  it("blocks a new trigger while a cancelled deploy still holds the lease", async () => {
    mocks.findProject.mockResolvedValue({ ...project, deployLeaseId: "dep_cancelled" });
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_cancelled") return { id, status: "cancelled" };
      return null;
    });
    await expect(checkNoActiveBuild("p1")).rejects.toThrow(/still cleaning up/);
  });

  it("does not revert current when the row is ready at revert time", async () => {
    mocks.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes("readlink")) return "releases/dep_rel\n";
      return "";
    });
    mocks.findById.mockResolvedValue({
      ...dep,
      status: "ready",
      meta: { deploymentLane: "release", releasePreviousCurrent: "releases/dep_old" },
    });

    await revertIfIncompleteActivation(executor() as never, "p1", {
      ...dep,
      status: "deploying",
      meta: { deploymentLane: "release", releasePreviousCurrent: "releases/dep_old" },
    } as never);

    expect(
      mocks.exec.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("ln -sfn") &&
          call[0].includes("releases/dep_old"),
      ),
    ).toBe(false);
  });

  it("cancel of a building runtime deploy does not release the lease", async () => {
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_rel") {
        return {
          ...dep,
          status: "building",
          organizationId: "org1",
          projectId: "p1",
          meta: {},
        };
      }
      return null;
    });
    mocks.findProject.mockResolvedValue({ ...project, organizationId: "org1" });

    await cancelBuildSession("dep_rel");

    expect(mocks.releaseDeployLease).not.toHaveBeenCalled();
  });

  it("cancel does not release the lease while a worker is running", async () => {
    beginDeployRun("dep_rel");
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_rel") {
        return { ...dep, status: "building", organizationId: "org1", projectId: "p1" };
      }
      return null;
    });
    mocks.findProject.mockResolvedValue({ ...project, organizationId: "org1" });

    await cancelBuildSession("dep_rel");

    expect(mocks.releaseDeployLease).not.toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenCalledWith("dep_rel", "cancelled");
    mocks.claimDeployLease.mockResolvedValue(false);
    mocks.create.mockResolvedValue({ ...dep, id: "dep_new" });
    await expect(
      createQueuedDeployment({
        projectId: "p1",
        organizationId: "org1",
        branch: "main",
        environment: "production",
        framework: "laravel",
        meta: { deploymentLane: "release" } as never,
        envVars: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    endDeployRun("dep_rel");
  });

  it("rejects a second concurrent enqueue when the lease is held", async () => {
    mocks.create
      .mockResolvedValueOnce({ ...dep, id: "dep_a" })
      .mockResolvedValueOnce({ ...dep, id: "dep_b" });
    mocks.claimDeployLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await createQueuedDeployment({
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      environment: "production",
      framework: "laravel",
      meta: { deploymentLane: "release" } as never,
      envVars: null,
    });
    await expect(
      createQueuedDeployment({
        projectId: "p1",
        organizationId: "org1",
        branch: "main",
        environment: "production",
        framework: "laravel",
        meta: { deploymentLane: "release" } as never,
        envVars: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(first.id).toBe("dep_a");
    expect(mocks.deleteDeployment).toHaveBeenCalledWith("dep_b");
  });

  it("does not flip current or setActive when cancelled before activate", async () => {
    let cancelled = false;
    mocks.setReleasePhase.mockImplementation(async (_id: string, phase: string) => {
      if (phase === "activating") {
        cancelled = true;
        return false;
      }
      return true;
    });
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_runtime") {
        return { id: "dep_runtime", status: "ready", meta: { serverId: "srv1" } };
      }
      return { ...dep, status: cancelled ? "cancelled" : "building" };
    });

    await runMountedRelease(ctx, project as never, { ...dep } as never);

    const flipped = mocks.exec.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("ln -sfn") && call[0].includes("current.next"),
    );
    expect(flipped).toBe(false);
    expect(mocks.setActiveReleaseDeployment).not.toHaveBeenCalled();
    expect(mocks.releaseDeployLease).toHaveBeenCalledWith("p1", "dep_rel");
  });

  it("fail-cleans a mid-prepare restart without flipping current", async () => {
    const commands: string[] = [];
    mocks.exec.mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes("readlink")) return "releases/dep_old\n";
      return "";
    });

    await failCleanMountedRelease(
      project as never,
      { ...dep, status: "building", releasePhase: "preparing" } as never,
      "Interrupted by a server restart — redeploy to try again.",
    );

    expect(commands.some((cmd) => cmd.includes("docker rm -f"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("ln -sfn"))).toBe(false);
    expect(mocks.rm).toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "dep_rel",
      "failed",
      expect.objectContaining({ errorMessage: expect.stringContaining("restart") }),
    );
    expect(mocks.setActiveReleaseDeployment).not.toHaveBeenCalled();
  });

  it("reverts current on boot when health never passed after activate", async () => {
    const commands: string[] = [];
    const interrupted = {
      ...dep,
      status: "deploying",
      releasePhase: "health",
      meta: { deploymentLane: "release", releasePreviousCurrent: "releases/dep_old" },
    };
    mocks.findById.mockImplementation(async (id: string) => {
      if (id === "dep_rel") return interrupted;
      return null;
    });
    mocks.exec.mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes("readlink")) return "releases/dep_rel\n";
      return "";
    });

    await failCleanMountedRelease(
      project as never,
      interrupted as never,
      "Interrupted by a server restart — redeploy to try again.",
    );

    expect(commands.some((cmd) => cmd.includes("ln -sfn") && cmd.includes("releases/dep_old"))).toBe(
      true,
    );
    expect(mocks.updateStatus).toHaveBeenCalledWith("dep_rel", "failed", expect.anything());
  });

  it("boot recovery fail-cleans then releases the lease", async () => {
    mocks.listInFlight.mockResolvedValue([
      { ...dep, status: "building", releasePhase: "preparing", meta: { deploymentLane: "release" } },
    ]);
    mocks.listWithDeployLease.mockResolvedValue([{ ...project, deployLeaseId: "dep_rel" }]);

    const n = await recoverInterruptedDeployments("Interrupted by a server restart");

    expect(n).toBe(1);
    expect(mocks.releaseDeployLease).toHaveBeenCalledWith("p1", "dep_rel");
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "dep_rel",
      "failed",
      expect.objectContaining({ errorMessage: expect.stringContaining("restart") }),
    );
  });

  it("keeps the lease when fail-clean cannot reach the host", async () => {
    mocks.resolveServerExecutor.mockRejectedValue(new Error("host down"));
    mocks.listInFlight.mockResolvedValue([
      { ...dep, status: "building", releasePhase: "preparing", meta: { deploymentLane: "release" } },
    ]);
    mocks.listWithDeployLease.mockResolvedValue([{ ...project, deployLeaseId: "dep_rel" }]);

    const n = await recoverInterruptedDeployments("Interrupted by a server restart");

    expect(n).toBe(0);
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.releaseDeployLease).not.toHaveBeenCalled();
  });

  it("releases a dangling lease when the deployment row is gone", async () => {
    mocks.listInFlight.mockResolvedValue([]);
    mocks.listWithDeployLease.mockResolvedValue([{ ...project, deployLeaseId: "dep_gone" }]);
    mocks.findById.mockResolvedValue(null);

    const n = await recoverInterruptedDeployments("Interrupted by a server restart");

    expect(n).toBe(1);
    expect(mocks.releaseDeployLease).toHaveBeenCalledWith("p1", "dep_gone");
  });
});
