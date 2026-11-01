import { BuildLogger, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import { repos } from "@repo/db";
import { ServiceCutoverRecoveryError } from "@repo/platform/engine/modules/deployments/compose/cutover-recovery";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline is only wired here, not exercised: every collaborator is a side
// effect on the DB, the SSH host, or the SSE stream. Stubbing them leaves exactly
// one thing under test — which branch the cancel flag takes.
const mocks = vi.hoisted(() => ({
  buildComposeImages: vi.fn(),
  deployComposeServices: vi.fn(),
  cleanupBuildArtifact: vi.fn(async () => {}),
  finishServiceDeploymentTimings: vi.fn(async () => {}),
  onCancelled: vi.fn(async () => {}),
  onFailure: vi.fn(async () => {}),
  onReconciling: vi.fn(async () => {}),
  onSuccess: vi.fn(async () => {}),
  setDeploymentStatus: vi.fn(async (): Promise<boolean | void> => {}),
  promptUser: vi.fn(async () => "migrate"),
  keepProvisioned: false,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn(async () => ({ id: "p1", activeDeploymentId: "d1" })) },
    deployment: { findById: vi.fn(async () => ({ id: "dep-live", projectId: "p1", organizationId: "org1", status: "ready" })) },
    service: {
      listByProject: vi.fn(async () => [
        { id: "svc-api", name: "api", enabled: true, advanced: null },
        { id: "svc-worker", name: "worker", enabled: true, advanced: null },
      ]),
      listByDeployment: vi.fn(async () => []),
      markServiceDeploymentFailed: vi.fn(async () => undefined),
    },
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/compose/build.service", () => ({ buildComposeImages: mocks.buildComposeImages }));
vi.mock("@repo/platform/engine/modules/deployments/compose/required-env-preflight", () => ({
  assertRequiredServiceEnvironment: async () => {},
}));
vi.mock("@repo/platform/engine/modules/deployments/compose/deploy.service", () => ({
  deployComposeServices: mocks.deployComposeServices, composeDeployMadeNoChanges: () => false,
}));
vi.mock("@repo/platform/engine/modules/deployments/deployment-lifecycle", () => ({
  beginBuildTiming: vi.fn(),
  completeBuildTiming: vi.fn(),
  finishServiceDeploymentTimings: mocks.finishServiceDeploymentTimings,
  cleanupBuildArtifact: mocks.cleanupBuildArtifact,
  onCancelled: mocks.onCancelled,
  onFailure: mocks.onFailure,
  onReconciling: mocks.onReconciling,
  onSuccess: mocks.onSuccess,
  setDeploymentStatus: mocks.setDeploymentStatus,
  routeIssuesWarning: (issues: string[]) => issues.join(", "),
}));
vi.mock("@repo/platform/engine/modules/deployments/session-manager", () => ({
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
  promptUser: mocks.promptUser,
}));
vi.mock("@repo/platform/engine/modules/deployments/deployment-cancellation", () => ({
  deploymentCancellationKeepsProvisioned: () => mocks.keepProvisioned,
  raceDeploymentCancellation: <T>(task: Promise<T>) => task,
  throwIfDeploymentCancelled: (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("Deployment cancelled");
  },
}));

import { executeComposePipeline } from "@repo/platform/engine/modules/deployments/compose/pipeline";

/**
 * `setDeploymentStatus` has NO terminal-state guard, so the cancel branch is the
 * only thing standing between a cancelled deployment and a live one: fall through
 * and the "cancelled" row is flipped back to "deploying" and the containers the
 * user cancelled start anyway. Pinned here because the failure is silent — the
 * deploy succeeds, which is exactly what it must not do.
 */

const SNAPSHOT = {
  repoUrl: "https://example.com/repo.git",
  branch: "main",
  framework: "docker",
  buildImage: "",
  runtimeImage: "",
  packageManager: "",
  installCommand: "",
  buildCommand: "",
  outputDirectory: "",
  productionPaths: [] as string[],
  rootDirectory: "",
  port: 3000,
  startCommand: "",
  hasServer: true,
  hasBuild: false,
};

/** Thrown BY the deploy step, so "did we get there" needs nothing downstream of it. */
const REACHED_DEPLOY = new Error("reached the deploy step");

async function run(
  composeBuild: Record<string, unknown>,
  snapshot = SNAPSHOT,
  options: { runtimeName?: string; activeDeploymentId?: string; onBuildFinished?: () => Promise<void>; signal?: AbortSignal } = {},
) {
  mocks.buildComposeImages.mockResolvedValue(composeBuild);
  // Deploying for real would drag in every collaborator past this point (and pin
  // this test to whatever the happy path grows next). All that matters here is
  // whether control reaches it at all.
  mocks.deployComposeServices.mockRejectedValue(REACHED_DEPLOY);

  await executeComposePipeline({
    project: {
      id: "p1",
      organizationId: "org1",
      slug: "app",
      name: "app",
      webhookDomain: null,
      activeDeploymentId: options.activeDeploymentId ?? null,
    } as never,
    dep: { id: "d1", branch: "main", commitSha: null, trigger: "deploy", meta: null } as never,
    runtime: {
      name: options.runtimeName ?? "docker",
      supports: () => false,
    } as never,
    routing: {} as never,
    ssl: {} as never,
    system: null,
    executor: null,
    usesManagedRouting: false,
    logger: new BuildLogger(() => {}),
    ctx: { dep: { id: "d1" }, provisioned: {} } as never,
    snapshot: snapshot as never,
    buildSessionId: "bld_x",
    composeInterpolationEnv: {},
    buildEnvVars: {},
    buildResources: DEFAULT_RESOURCE_CONFIG,
    runtimeResources: DEFAULT_RESOURCE_CONFIG,
    onBuildFinished: options.onBuildFinished,
    signal: options.signal,
  });
}

describe("executeComposePipeline — cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.keepProvisioned = false;
    mocks.onSuccess.mockReset().mockResolvedValue(undefined);
    vi.mocked(repos.project.findById).mockResolvedValue({ id: "p1", activeDeploymentId: "d1" } as never);
    vi.mocked(repos.deployment.findById).mockResolvedValue({ id: "dep-live", projectId: "p1", organizationId: "org1", status: "ready" } as never);
    vi.mocked(repos.service.listByDeployment).mockResolvedValue([]);
    mocks.cleanupBuildArtifact.mockResolvedValue(undefined);
  });

  function completedCutover() {
    const commit = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => true);
    mocks.deployComposeServices.mockResolvedValueOnce({
      status: "ready", primaryContainerId: "new-api", cutover: { containerId: "new-api", commit, rollback },
      summary: { total: 1, successful: 1, deployed: 1, failed: 0, indeterminate: 0, mutated: false, failedServices: [] },
      services: [{ serviceId: "svc-api", serviceName: "api", containerId: "new-api", status: "running" }],
    });
    const built = { cancelled: false, buildFailures: new Map(), imageRefs: new Map([["svc-api", "image:v2"]]),
      builtImageRefs: new Map([["svc-api", "image:v2"]]), staticArtifactRefs: new Map(),
      staticServiceIds: new Set(), durationMs: 5 };
    return { commit, rollback, built };
  }

  it("cleans built artifacts without cutover when cancellation wins the release transition", async () => {
    const f = completedCutover();
    mocks.deployComposeServices.mockReset();
    mocks.setDeploymentStatus.mockResolvedValueOnce(false);
    await run(f.built);
    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(expect.anything(), "image:v2");
    expect(mocks.onCancelled).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("retires the predecessor only after the new outcome and active pointer are confirmed", async () => {
    const f = completedCutover();
    mocks.onSuccess.mockImplementation(async (...args: unknown[]) => {
      expect(f.commit).not.toHaveBeenCalled();
      (args[0] as { settled?: string }).settled = "ready";
    });
    await run(f.built);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(repos.project.findById).mock.invocationCallOrder.at(-1)!,
    );
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it("rolls routing back if the ready-outcome CAS loses to cancellation", async () => {
    const f = completedCutover();
    mocks.onSuccess.mockImplementation(async (...args: unknown[]) => {
      (args[0] as { settled?: string }).settled = "cancelled";
    });
    await run(f.built);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.rollback).toHaveBeenCalledOnce();
    expect(mocks.onCancelled).toHaveBeenCalledWith(expect.anything(), 5, { keepProvisioned: false });
    expect(f.rollback.mock.invocationCallOrder[0]).toBeLessThan(mocks.onCancelled.mock.invocationCallOrder[0]!);
  });

  it("preserves both workloads if routing cannot be rolled back after a refused CAS", async () => {
    const f = completedCutover();
    f.rollback.mockResolvedValue(false);
    mocks.onSuccess.mockImplementation(async (...args: unknown[]) => {
      (args[0] as { settled?: string }).settled = "cancelled";
    });
    await run(f.built);
    expect(f.commit).not.toHaveBeenCalled();
    expect(mocks.onCancelled).toHaveBeenCalledWith(expect.anything(), 5, { keepProvisioned: true });
    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
  });

  it("keeps the predecessor when the active deployment pointer was not saved", async () => {
    const f = completedCutover();
    mocks.onSuccess.mockImplementation(async (...args: unknown[]) => {
      (args[0] as { settled?: string }).settled = "ready";
    });
    vi.mocked(repos.project.findById).mockResolvedValue({ id: "p1", activeDeploymentId: "d-old" } as never);
    await run(f.built);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it("does not retire the predecessor when onSuccess could not record the ready outcome", async () => {
    const f = completedCutover();
    mocks.onSuccess.mockImplementation(async (...args: unknown[]) => {
      (args[0] as { settled?: string }).settled = "ready";
    });
    vi.mocked(repos.deployment.findById).mockResolvedValue({
      id: "d1", projectId: "p1", organizationId: "org1", status: "deploying",
    } as never);
    await run(f.built);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it("records a terminal failure and preserves both workloads when route recovery is uncertain", async () => {
    const f = completedCutover();
    mocks.deployComposeServices.mockReset().mockRejectedValueOnce(new ServiceCutoverRecoveryError("new-api"));
    await run(f.built);
    expect(mocks.onFailure).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Both containers were preserved"), 5,
      { errorCode: "SERVICE_CUTOVER_RECOVERY_REQUIRED" }, { keepProvisioned: true });
    expect(mocks.onReconciling).not.toHaveBeenCalled();
    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
  });

  it("does not let cancellation cleanup remove a candidate whose routes could not be restored", async () => {
    const f = completedCutover();
    const controller = new AbortController();
    mocks.deployComposeServices.mockReset().mockImplementationOnce(async () => {
      controller.abort();
      throw new ServiceCutoverRecoveryError("new-api");
    });
    await run(f.built, SNAPSHOT, { signal: controller.signal });
    expect(mocks.onCancelled).toHaveBeenCalledWith(expect.anything(), 5, { keepProvisioned: true });
    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
  });

  it("stops before the deploy phase and never re-flips the status", async () => {
    await run({
      cancelled: true,
      buildFailures: new Map(),
      imageRefs: new Map(),
      builtImageRefs: new Map([["svc-0", "img/svc-0"]]),
      durationMs: 5,
    });

    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
    expect(mocks.setDeploymentStatus).not.toHaveBeenCalled();
    expect(mocks.onCancelled).toHaveBeenCalledWith(expect.anything(), 5, {
      keepProvisioned: false,
    });
    // Whatever finished building before the cancel landed is garbage — nothing
    // references it and no deploy will.
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(expect.anything(), "img/svc-0");
    expect(mocks.finishServiceDeploymentTimings).toHaveBeenCalledOnce();
    expect(mocks.finishServiceDeploymentTimings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cleanupBuildArtifact.mock.invocationCallOrder[0]!,
    );
  });

  it("still cleans up when a built image refuses to delete", async () => {
    mocks.cleanupBuildArtifact.mockRejectedValueOnce(new Error("image in use"));

    await run({
      cancelled: true,
      buildFailures: new Map(),
      imageRefs: new Map(),
      builtImageRefs: new Map([
        ["svc-0", "img/svc-0"],
        ["svc-1", "img/svc-1"],
      ]),
      durationMs: 5,
    });

    // A stuck image must not abort the cancel: the second cleanup still runs and
    // the deployment still lands on `cancelled`.
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.onCancelled).toHaveBeenCalledTimes(1);
    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
  });

  it("record-only cancellation leaves built artifacts provisioned", async () => {
    mocks.keepProvisioned = true;

    await run({
      cancelled: true,
      buildFailures: new Map(),
      imageRefs: new Map(),
      builtImageRefs: new Map([["svc-0", "img/svc-0"]]),
      durationMs: 5,
    });

    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
    expect(mocks.onCancelled).toHaveBeenCalledWith(expect.anything(), 5, {
      keepProvisioned: true,
    });
  });

  // Negative control: without it, a branch that always returned early would pass
  // both tests above.
  it("proceeds to deploy when the build was not cancelled", async () => {
    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([["svc-0", "img/svc-0"]]),
        builtImageRefs: new Map([["svc-0", "img/svc-0"]]),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.onCancelled).not.toHaveBeenCalled();
    expect(mocks.setDeploymentStatus).toHaveBeenCalledWith("d1", "deploying", expect.anything());
    const deployOpts = mocks.deployComposeServices.mock.calls[0]?.[4];
    const prompt = { promptId: "edge_conflict" };
    await expect(deployOpts.promptUser(prompt)).resolves.toBe("migrate");
    expect(mocks.promptUser).toHaveBeenCalledWith("d1", prompt);
  });

  it("cleans definitely-unused built artifacts when deployment throws", async () => {
    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([
          ["svc-api", "openship/api:bld_x"],
          ["svc-worker", "openship/worker:bld_x"],
        ]),
        builtImageRefs: new Map([
          ["svc-api", "openship/api:bld_x"],
          ["svc-worker", "openship/worker:bld_x"],
        ]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.finishServiceDeploymentTimings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cleanupBuildArtifact.mock.invocationCallOrder[0]!,
    );
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/api:bld_x",
    );
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/worker:bld_x",
    );
  });

  it("settles every exact target when cohort preparation throws before cutover", async () => {
    await expect(
      run(
        {
          cancelled: false,
          buildFailures: new Map(),
          imageRefs: new Map([
            ["svc-api", "ghcr.io/acme/api:staging"],
            ["svc-worker", "ghcr.io/acme/worker:staging"],
          ]),
          builtImageRefs: new Map(),
          staticArtifactRefs: new Map(),
          staticServiceIds: new Set(),
          durationMs: 5,
        },
        {
          ...SNAPSHOT,
          targetServiceIds: ["svc-api", "svc-worker"],
          strictServiceScope: true,
          forcePullImages: true,
        } as typeof SNAPSHOT,
      ),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(repos.service.markServiceDeploymentFailed).toHaveBeenCalledTimes(2);
    expect(repos.service.markServiceDeploymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "svc-api",
        reason: "cohort-aborted",
        errorMessage: expect.stringContaining("reached the deploy step"),
      }),
    );
    expect(repos.service.markServiceDeploymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "svc-worker", reason: "cohort-aborted" }),
    );
  });

  it("cleans failed-row artifacts while protecting deployed and shared refs", async () => {
    vi.mocked(repos.service.listByDeployment).mockResolvedValue([
      {
        serviceId: "svc-live",
        status: "success",
        imageRef: "a-different-ref-is-still-conservative",
      },
      { serviceId: "svc-unknown", status: "indeterminate", imageRef: null },
      { serviceId: "svc-failed", status: "failure", imageRef: "openship/failed:bld_x" },
      { serviceId: "svc-unused", status: "skipped", imageRef: null },
    ] as never);

    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map(),
        builtImageRefs: new Map([
          ["svc-live", "openship/shared:bld_x"],
          ["svc-shared", "openship/shared:bld_x"],
          ["svc-unknown", "openship/unknown:bld_x"],
          ["svc-failed", "openship/failed:bld_x"],
          ["svc-unused", "openship/unused:bld_x"],
        ]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/failed:bld_x",
    );
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/unused:bld_x",
    );
    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalledWith(
      expect.anything(),
      "openship/shared:bld_x",
    );
  });

  it("does not mask the deploy error when artifact cleanup fails", async () => {
    mocks.cleanupBuildArtifact.mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        builtImageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(1);
  });

  it("retains every built artifact once service activation may have started", async () => {
    mocks.deployComposeServices.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as { onArtifactActivationStart?: (serviceId: string) => void };
      options.onArtifactActivationStart?.("svc-api");
      throw REACHED_DEPLOY;
    });

    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([
          ["svc-api", "openship/api:bld_x"],
          ["svc-worker", "openship/worker:bld_x"],
        ]),
        builtImageRefs: new Map([
          ["svc-api", "openship/api:bld_x"],
          ["svc-worker", "openship/worker:bld_x"],
        ]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
  });

  it("retains artifacts when ownership evidence cannot be read", async () => {
    vi.mocked(repos.service.listByDeployment).mockRejectedValueOnce(new Error("database down"));

    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        builtImageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
  });

  it("forwards exact scope and mutable-image pull intent to the compose deployer", async () => {
    await expect(
      run(
        {
          cancelled: false,
          buildFailures: new Map(),
          imageRefs: new Map([
            ["svc-api", "ghcr.io/acme/api:staging"],
            ["svc-worker", "ghcr.io/acme/worker:staging"],
          ]),
          builtImageRefs: new Map(),
          staticArtifactRefs: new Map(),
          staticServiceIds: new Set(),
          durationMs: 5,
        },
        {
          ...SNAPSHOT,
          targetServiceIds: ["svc-api", "svc-worker"],
          strictServiceScope: true,
          forcePullImages: true,
        } as typeof SNAPSHOT,
      ),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.deployComposeServices).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        targetServiceIds: new Set(["svc-api", "svc-worker"]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        strictScope: true,
        forcePullImages: true,
      }),
    );
  });

  it("revalidates an exact target set in the worker before building", async () => {
    vi.mocked(repos.service.listByProject).mockResolvedValueOnce([
      { id: "svc-api", name: "api", enabled: true, advanced: null } as never,
    ]);

    await expect(
      run(
        {
          cancelled: false,
          buildFailures: new Map(),
          imageRefs: new Map(),
          builtImageRefs: new Map(),
          durationMs: 5,
        },
        {
          ...SNAPSHOT,
          targetServiceIds: ["svc-api", "svc-deleted"],
          strictServiceScope: true,
          forcePullImages: true,
        } as typeof SNAPSHOT,
      ),
    ).rejects.toThrow(/svc-deleted/);

    expect(mocks.buildComposeImages).not.toHaveBeenCalled();
    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
  });

  it("aborts an exact cohort before cutover when one selected image build fails", async () => {
    const buildError = "Docker build failed: worker image did not compile";

    await run(
      {
        cancelled: false,
        buildFailures: new Map([["svc-worker", buildError]]),
        imageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        builtImageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 17,
      },
      {
        ...SNAPSHOT,
        targetServiceIds: ["svc-api", "svc-worker"],
        strictServiceScope: true,
        forcePullImages: true,
      } as typeof SNAPSHOT,
    );

    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
    expect(mocks.setDeploymentStatus).not.toHaveBeenCalled();
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/api:bld_x",
    );
    expect(repos.service.markServiceDeploymentFailed).toHaveBeenCalledTimes(2);
    expect(repos.service.markServiceDeploymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "svc-worker",
        errorMessage: buildError,
        reason: "build-failed",
      }),
    );
    expect(repos.service.markServiceDeploymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "svc-api",
        reason: "cohort-aborted",
      }),
    );
    expect(mocks.onFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/aborted before cutover.*worker image did not compile/i),
      17,
      undefined,
    );
  });

  it("keeps legacy partial-build behavior outside an exact scope", async () => {
    await expect(
      run({
        cancelled: false,
        buildFailures: new Map([["svc-worker", "worker failed"]]),
        imageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        builtImageRefs: new Map([["svc-api", "openship/api:bld_x"]]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.onFailure).not.toHaveBeenCalled();
  });

  it("uses the shared Docker refresh flow for mutable images on a managed server", async () => {
    vi.mocked(repos.service.listByDeployment).mockResolvedValueOnce([
      {
        serviceId: "svc-api",
        containerId: "workspace-live",
      } as never,
    ]);

    await expect(run(
      {
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([
          ["svc-api", "ghcr.io/acme/api:staging"],
          ["svc-worker", "openship/worker:bld_x"],
        ]),
        builtImageRefs: new Map([["svc-worker", "openship/worker:bld_x"]]),
        staticArtifactRefs: new Map(),
        staticServiceIds: new Set(),
        durationMs: 23,
      },
      {
        ...SNAPSHOT,
        targetServiceIds: ["svc-api", "svc-worker"],
        strictServiceScope: true,
        forcePullImages: true,
      } as typeof SNAPSHOT,
      { runtimeName: "docker", activeDeploymentId: "dep-live" },
    )).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.deployComposeServices).toHaveBeenCalledOnce();
    expect(mocks.onFailure).not.toHaveBeenCalled();
  });

});


describe("Compose Cloud build release hook smoke", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.keepProvisioned = false; mocks.cleanupBuildArtifact.mockResolvedValue(undefined); });
  const cancelledBuild = () => ({ cancelled: true, buildFailures: new Map(), imageRefs: new Map(),
    builtImageRefs: new Map([["svc-api", "built-image"]]), durationMs: 5 });

  it("waits for slot release before moving past the completed image-build phase", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const onBuildFinished = vi.fn(() => pending);
    const running = run(cancelledBuild(), SNAPSHOT, { onBuildFinished });
    try {
      await vi.waitFor(() => expect(onBuildFinished).toHaveBeenCalledOnce());
      expect(mocks.buildComposeImages).toHaveBeenCalledOnce();
      expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
      expect(mocks.deployComposeServices).not.toHaveBeenCalled();
    } finally { release(); await running; }
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(expect.anything(), "built-image");
  });

  it("a release-hook failure must not bypass cancellation artifact cleanup", async () => {
    const failure = new Error("slot release unavailable");
    await expect(run(cancelledBuild(), SNAPSHOT, {
      onBuildFinished: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(expect.anything(), "built-image");
  });
});
