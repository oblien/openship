import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBuildSessionByDeploymentId: vi.fn(),
  claimBuildExecution: vi.fn(),
  cancelUnclaimedBuild: vi.fn(),
  acknowledgeBuildExecutionFinished: vi.fn(),
  findCloudDockerBinding: vi.fn(),
  hasLiveBuildExecution: vi.fn(),
  updateDeploymentStatus: vi.fn(),
  updateBuildSession: vi.fn(),
  findDeploymentById: vi.fn(),
  prepareImage: vi.fn(),
  runReleaseCommand: vi.fn(),
  build: vi.fn(),
  cancelBuild: vi.fn(),
  deploy: vi.fn(),
  destroy: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  getContainerInfo: vi.fn(),
  runDeployPipeline: vi.fn(),
  resolveBuildGitToken: vi.fn(),
  openDeployRelay: vi.fn(),
  onFailure: vi.fn(),
  onCancelled: vi.fn(),
  onSuccess: vi.fn(),
  reportPipelineError: vi.fn(),
  setDeploymentStatus: vi.fn(),
  onDeploymentReady: vi.fn(),
  createSession: vi.fn(),
  appendLog: vi.fn(),
  promptUser: vi.fn(),
  cancelPendingPrompt: vi.fn(),
  ensureRoutingReady: vi.fn(),
  prepareTargetPinnedHostPorts: vi.fn(),
  allocateAndReservePinnedHostPort: vi.fn(),
  reserveTargetPinnedHostPort: vi.fn(),
  reserveVerifiedTargetPinnedHostPort: vi.fn(),
  convergeTargetHostPortClaims: vi.fn(),
  convergeTargetHostPortClaimsUnlocked: vi.fn(),
  withHostPortTargetLock: vi.fn((_target, fn: () => unknown) => fn()),
  withWorkspaceActivity: vi.fn(),
  sshWithHostExecutor: vi.fn(),
  sampleCloudWorkspaceResources: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  schema: {},
  repos: {
    cloudDockerWorkspace: { find: (...args: unknown[]) => mocks.findCloudDockerBinding(...args) },
    deployment: {
      findBuildSessionByDeploymentId: (...args: unknown[]) =>
        mocks.findBuildSessionByDeploymentId(...args),
      claimBuildExecution: (...args: unknown[]) => mocks.claimBuildExecution(...args),
      cancelUnclaimedBuild: (...args: unknown[]) => mocks.cancelUnclaimedBuild(...args),
      acknowledgeBuildExecutionFinished: (...args: unknown[]) =>
        mocks.acknowledgeBuildExecutionFinished(...args),
      hasLiveBuildExecution: (...args: unknown[]) => mocks.hasLiveBuildExecution(...args),
      updateStatus: (...args: unknown[]) => mocks.updateDeploymentStatus(...args),
      updateBuildSession: (...args: unknown[]) => mocks.updateBuildSession(...args),
      findById: (...args: unknown[]) => mocks.findDeploymentById(...args),
    },
    service: {
      listByProject: vi.fn(async () => []),
      listByDeployment: vi.fn(async () => []),
      syncFromCompose: vi.fn(async () => undefined),
    },
    serviceDeployment: { listByDeployment: vi.fn(async () => []) },
    domain: {
      listByProject: vi.fn(async () => []),
      remove: vi.fn(async () => undefined),
    },
    project: { update: vi.fn(async () => undefined) },
  },
}));

vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: (...args: unknown[]) => mocks.withWorkspaceActivity(...args),
}));

vi.mock("@repo/adapters", () => {
  class BuildLogger {
    constructor(private readonly callback?: (entry: unknown) => void) {}

    log(message: string, level = "info") {
      this.callback?.({ timestamp: new Date().toISOString(), message, level });
    }

    step(phase: string, status: string, message: string) {
      this.callback?.({
        timestamp: new Date().toISOString(),
        phase,
        status,
        message,
        level: "info",
      });
    }
  }

  return {
    BuildLogger,
    LocalExecutor: class LocalExecutor {},
    BareRuntime: class BareRuntime {},
    DockerRuntime: class DockerRuntime {},
    CloudRuntime: class CloudRuntime {},
    CloudDockerRuntime: class CloudDockerRuntime {},
    STATIC_RELEASE_BASE: "/opt/openship/static/releases",
    sharedMountExecutor: vi.fn(async () => null),
    resolveStaticOutputPath: (id: string) => id,
    ensurePortAvailable: vi.fn(async () => undefined),
    allocateHostPort: vi.fn(async () => ({ port: 30_000, scanned: true })),
    pickHostPort: vi.fn(() => 30_000),
    edgeProxyFor: vi.fn(() => ({ listLoopbackUpstreamPortsStrict: vi.fn() })),
    isHostChannelUnavailableError: vi.fn(() => false),
    runDeployPipeline: (...args: unknown[]) => mocks.runDeployPipeline(...args),
    isMultiServiceRuntime: vi.fn(() => false),
    ensureEdge: vi.fn(async (_executor, install, options) => ({
      migrated: false,
      value: await install(options.promptUser),
    })),
  };
});

vi.mock("../../lib/controller-helpers", () => ({ platform: vi.fn() }));

vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  disposeRuntime: vi.fn(),
  resolveDeploymentRuntime: vi.fn(),
  resolveDeploymentPlatform: vi.fn(),
  resolveEffectiveTarget: vi.fn(() => "local"),
  hostChannelDeployNotice: vi.fn(() => null),
}));

vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  resolveProjectRouteState: vi.fn(async () => ({
    publicEndpoints: [],
    primarySlug: "release-app",
  })),
}));

vi.mock("@repo/platform/engine/modules/github/clone-auth", () => ({
  cloneOnServerAvailable: vi.fn(() => ({ available: false })),
  resolveBuildGitToken: (...args: unknown[]) => mocks.resolveBuildGitToken(...args),
}));

vi.mock("@repo/platform/engine/lib/git-forwarding/index", () => ({
  openDeployRelay: (...args: unknown[]) => mocks.openDeployRelay(...args),
}));

vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: vi.fn(async () => null) }));
vi.mock("@repo/platform/engine/modules/settings/settings.service", () => ({
  resolveStrategy: vi.fn(async () => "server"),
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({
  decryptEnvMap: (env: Record<string, string>) => env,
}));
vi.mock("@repo/platform/engine/lib/resources", async (importOriginal) => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/resources")>(),
  resolveRuntimeResources: vi.fn(() => ({})),
  resolveBuildResources: vi.fn(() => ({})),
}));
vi.mock("@repo/platform/engine/lib/plan-guard", () => ({
  assertCloudDeploymentLimits: vi.fn(async () => undefined),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-host", async (importOriginal) => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/cloud-workspace-host")>(),
  sampleCloudWorkspaceResources: (...args: unknown[]) => mocks.sampleCloudWorkspaceResources(...args),
}));
vi.mock("../../lib/request-context", () => ({ buildBackgroundContext: vi.fn(() => ({})) }));

vi.mock("@repo/platform/engine/modules/deployments/session-manager", () => ({
  createSession: (...args: unknown[]) => mocks.createSession(...args),
  appendLog: (...args: unknown[]) => mocks.appendLog(...args),
  updateStatus: vi.fn(),
  promptUser: (...args: unknown[]) => mocks.promptUser(...args),
  cancelPendingPrompt: (...args: unknown[]) => mocks.cancelPendingPrompt(...args),
  endSession: vi.fn(),
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/deployments/service-checks", () => ({
  preCreateServiceDeployments: vi.fn(async () => new Map()),
  emitServiceCheckRun: vi.fn(async () => undefined),
  emitInitialServiceChecks: vi.fn(async () => undefined),
  rollupDeploymentStatus: vi.fn(() => "ready"),
}));

vi.mock("@repo/platform/engine/modules/deployments/compose/index", () => ({
  executeComposePipeline: vi.fn(),
  resolveProjectServicePreflightServices: vi.fn(async () => []),
  shouldUseProjectServicePipeline: vi.fn(async () => false),
}));

vi.mock("@repo/platform/engine/modules/backups/triggers/pre-deploy", () => ({
  firePreDeployBackups: vi.fn(async () => ({ enqueued: 0, completed: 0 })),
}));

vi.mock("@repo/platform/engine/modules/deployments/deployment-lifecycle", () => ({
  onFailure: (...args: unknown[]) => mocks.onFailure(...args),
  onSuccess: (...args: unknown[]) => mocks.onSuccess(...args),
  onCancelled: (...args: unknown[]) => mocks.onCancelled(...args),
  reportPipelineError: (...args: unknown[]) => mocks.reportPipelineError(...args),
  setDeploymentStatus: (...args: unknown[]) => mocks.setDeploymentStatus(...args),
  routeIssuesWarning: vi.fn(() => "routing warning"),
}));

vi.mock("@repo/platform/engine/modules/deployments/rollback/index", () => ({
  onDeploymentReady: (...args: unknown[]) => mocks.onDeploymentReady(...args),
}));

vi.mock("@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator", () => ({
  reconcileProjectRetentionSafe: vi.fn(async () => undefined),
}));

vi.mock("@repo/platform/engine/lib/routing-domains", () => ({
  auditRoutedDomainTls: vi.fn(async () => []),
  buildProjectRouteDomains: vi.fn(() => []),
  createTrackedSslProvider: vi.fn((ssl) => ssl),
  ensureRouteDomainRecord: vi.fn(),
  toRoutedDomainInputs: vi.fn(() => []),
  withEnsuredDomainRecord: vi.fn((route) => route),
}));

vi.mock("@repo/platform/engine/lib/openship-manifest-sync", () => ({
  syncProjectToServerManifest: vi.fn(async () => undefined),
}));
vi.mock("@repo/platform/engine/modules/deployments/attach-linked-networks", () => ({ attachLinkedNetworks: vi.fn(async () => undefined) }));
vi.mock("@repo/platform/engine/modules/deployments/port-audit.service", () => ({ auditPorts: vi.fn(async () => []) }));
vi.mock("@repo/platform/engine/modules/deployments/stability-audit.service", () => ({ verifyDeployedContainers: vi.fn(async () => []) }));
vi.mock("@repo/platform/engine/modules/deployments/output-audit.service", () => ({
  auditStaticOutput: vi.fn(async () => []),
  describeOutputFinding: vi.fn(() => ""),
  outputFindingIsBroken: vi.fn(() => false),
  staticOutputTargets: vi.fn(() => []),
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes: vi.fn(async () => ({ failures: [] })),
  edgeUnsyncedWarning: vi.fn(() => ""),
}));
vi.mock("@repo/platform/engine/lib/project-routing-fields", () => ({
  compileProjectRoutingFields: vi.fn(() => ({})),
}));
vi.mock("@repo/platform/engine/lib/edge-challenge", () => ({ ensureEdgeChallengeReady: vi.fn() }));
vi.mock("@repo/platform/engine/lib/edge-vhost-repair", () => ({ repairEdgeVhosts: vi.fn() }));
vi.mock("@repo/platform/engine/lib/edge-reconcile", () => ({
  ensureRoutingReady: (...args: unknown[]) => mocks.ensureRoutingReady(...args),
}));
vi.mock("@repo/platform/engine/lib/acme-config", () => ({ resolveAcmeProviderOptions: vi.fn(() => ({})) }));
// A spy, not a working pooled channel: every test below gives the "server"
// target its own executor, so the real probe never needs this fallback. A
// readiness test asserts it was NOT called, to prove a Cloud target never
// reaches it either.
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withHostExecutor: (...args: unknown[]) => mocks.sshWithHostExecutor(...args) },
}));
vi.mock("@repo/platform/engine/modules/deployments/pinned-host-ports", () => ({
  listTargetPinnedHostPorts: vi.fn(async () => []),
  prepareTargetPinnedHostPorts: (...args: unknown[]) => mocks.prepareTargetPinnedHostPorts(...args),
  allocateAndReservePinnedHostPort: (...args: unknown[]) =>
    mocks.allocateAndReservePinnedHostPort(...args),
  releaseNewPinnedHostPortClaims: vi.fn(async () => 0),
  findOwnedPinnedHostPort: vi.fn(() => undefined),
  reserveTargetPinnedHostPort: (...args: unknown[]) => mocks.reserveTargetPinnedHostPort(...args),
  reserveVerifiedTargetPinnedHostPort: (...args: unknown[]) =>
    mocks.reserveVerifiedTargetPinnedHostPort(...args),
  convergeTargetHostPortClaims: (...args: unknown[]) => mocks.convergeTargetHostPortClaims(...args),
  convergeTargetHostPortClaimsUnlocked: (...args: unknown[]) =>
    mocks.convergeTargetHostPortClaimsUnlocked(...args),
  pinnedHostPortsToAvoid: vi.fn(() => new Set()),
  ownsReusablePinnedHostPort: vi.fn(() => false),
  withHostPortTargetLock: (target: unknown, fn: () => unknown) =>
    mocks.withHostPortTargetLock(target, fn),
}));

function allocatePinnedHostPort(input: {
  allocate: (options: { preferred?: number }) => Promise<{ port: number; scanned: boolean }>;
  cachedPreferred?: number;
  owner: { projectId: string; serviceId: string | null; containerPort: number | null };
}) {
  return input.allocate({ preferred: input.cachedPreferred }).then((allocation) => ({
    ...allocation,
    preferred: input.cachedPreferred,
    claim: {
      id: "hpc_test",
      targetKey: "local",
      ...input.owner,
      port: allocation.port,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  }));
}

import { repos } from "@repo/db";
import { ensurePortAvailable, isMultiServiceRuntime } from "@repo/adapters";
import { firePreDeployBackups } from "@repo/platform/engine/modules/backups/triggers/pre-deploy";
import { executeComposePipeline, resolveProjectServicePreflightServices, shouldUseProjectServicePipeline } from "@repo/platform/engine/modules/deployments/compose/index";
import { buildComposeImages } from "@repo/platform/engine/modules/deployments/compose/build.service";
import { resolveBuildResources } from "@repo/platform/engine/lib/resources";
import { env } from "@repo/platform/engine/config/index";
import { platform } from "@repo/platform/engine/lib/platform-config";
import { resolveDeploymentPlatform, resolveDeploymentRuntime } from "@repo/platform/engine/lib/deployment-runtime";
import { runDeployPipeline as runRealDeployPipeline } from "../../../../../packages/adapters/src/runtime/deploy-pipeline";
import {
  kickoffBuild,
  resolveServicePipelineMode,
} from "@repo/platform/engine/modules/deployments/build-pipeline";
import {
  drainDeploymentExecutions,
  registerDeploymentExecution,
  releaseDeploymentExecution,
  requestDeploymentCancellation,
  waitForDeploymentQuiescence,
  raceDeploymentCancellation,
} from "@repo/platform/engine/modules/deployments/deployment-cancellation";

const SOURCE_IMAGE = "ghcr.io/acme/release-app:v1.2.3";
const RESOLVED_IMAGE = "ghcr.io/acme/release-app@sha256:abc123";

function runtime() {
  return {
    name: "docker",
    capabilities: new Set(["prebuiltImage", "deploy", "containerIp", "releaseCommand"]),
    supports: (capability: string): boolean =>
      capability === "prebuiltImage" || capability === "deploy" || capability === "containerIp" || capability === "releaseCommand",
    prepareImage: (...args: unknown[]) => mocks.prepareImage(...args),
    runReleaseCommand: (...args: unknown[]) => mocks.runReleaseCommand(...args),
    build: (...args: unknown[]) => mocks.build(...args),
    cancelBuild: (...args: unknown[]) => mocks.cancelBuild(...args),
    deploy: (...args: unknown[]) => mocks.deploy(...args),
    destroy: (...args: unknown[]) => mocks.destroy(...args),
    stop: (...args: unknown[]) => mocks.stop(...args),
    start: (...args: unknown[]) => mocks.start(...args),
    getContainerInfo: (...args: unknown[]) => mocks.getContainerInfo(...args),
    getContainerIp: async () => "172.18.0.2",
  };
}

let resolvedRuntime: ReturnType<typeof runtime>;
let resolvedPlatform: Awaited<ReturnType<typeof resolveDeploymentPlatform>>;

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    organizationId: "org-1",
    name: "Release app",
    slug: "release-app",
    routeStrategy: "container-ip",
    rollbackStrategy: "snapshot",
    activeDeploymentId: null,
    ...overrides,
  } as never;
}

function snapshot() {
  return {
    organizationId: "org-1",
    repoUrl: "",
    branch: "main",
    framework: "docker",
    buildImage: "node:22",
    runtimeImage: "node:22-alpine",
    packageManager: "npm",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    productionPaths: [],
    volumes: [],
    rootDirectory: ".",
    port: 8080,
    startCommand: "",
    resources: null,
    buildResources: null,
    hasServer: true,
    hasBuild: false,
    source: "image",
    build: "prebuilt",
    workload: "web",
    runtimeMode: "docker",
    serviceDeploymentMode: "single",
    releaseVersion: "1.2.3",
    releaseTag: "v1.2.3",
    releaseImageRef: SOURCE_IMAGE,
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "deployment-1",
    projectId: "project-1",
    organizationId: "org-1",
    environment: "production",
    branch: "main",
    commitSha: null,
    trigger: "update",
    status: "queued",
    envVars: { API_TOKEN: "secret" },
    meta: snapshot(),
    ...overrides,
  } as never;
}

async function run(dep = deployment(), projectOverrides: Record<string, unknown> = {}) {
  mocks.findDeploymentById.mockResolvedValue(dep);
  const sessionId = await kickoffBuild(project(projectOverrides), dep);
  expect(sessionId).toBe("build-session-1");
  return dep;
}

describe("single-app prebuilt release-image pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensurePortAvailable).mockReset().mockResolvedValue(undefined);
    vi.mocked(shouldUseProjectServicePipeline).mockResolvedValue(false);
    vi.mocked(resolveProjectServicePreflightServices).mockResolvedValue([]);
    vi.mocked(isMultiServiceRuntime).mockReturnValue(false);
    vi.mocked(firePreDeployBackups).mockResolvedValue({ enqueued: 0, completed: 0 });
    mocks.findCloudDockerBinding.mockResolvedValue(undefined);
    mocks.withWorkspaceActivity.mockImplementation(async (_id, work) => work());
    const adapter = runtime();
    resolvedRuntime = adapter;

    mocks.findBuildSessionByDeploymentId.mockResolvedValue({ id: "build-session-1" });
    mocks.claimBuildExecution.mockResolvedValue("claimed");
    mocks.cancelUnclaimedBuild.mockResolvedValue(true);
    mocks.acknowledgeBuildExecutionFinished.mockResolvedValue(undefined);
    mocks.hasLiveBuildExecution.mockResolvedValue(false);
    mocks.updateDeploymentStatus.mockResolvedValue(undefined);
    mocks.updateBuildSession.mockResolvedValue(undefined);
    mocks.setDeploymentStatus.mockResolvedValue(undefined);
    mocks.getContainerInfo.mockResolvedValue({ ipAddress: "172.18.0.2" });
    mocks.destroy.mockResolvedValue(undefined);
    mocks.cancelBuild.mockResolvedValue(undefined);
    mocks.runReleaseCommand.mockResolvedValue(undefined);
    mocks.resolveBuildGitToken.mockResolvedValue({});
    mocks.prepareImage.mockResolvedValue({
      sessionId: "build-session-1",
      status: "deploying",
      imageRef: RESOLVED_IMAGE,
      durationMs: 12,
      artifactOwned: false,
    });
    mocks.deploy.mockResolvedValue({
      status: "success",
      containerId: "container-1",
      url: "http://172.18.0.2:8080",
    });
    mocks.runDeployPipeline.mockImplementation(async (env, input) => {
      const result = await env.activate(input.config, () => undefined);
      return {
        status: "success",
        containerId: result.containerId,
        url: result.url,
      };
    });
    mocks.onFailure.mockImplementation(async (ctx) => {
      if (ctx.provisioned.imageRef) await ctx.runtime.destroy(ctx.provisioned.imageRef);
    });
    mocks.onCancelled.mockImplementation(async (ctx) => {
      if (ctx.provisioned.imageRef) await ctx.runtime.destroy(ctx.provisioned.imageRef);
    });
    mocks.onSuccess.mockResolvedValue(undefined);
    mocks.reportPipelineError.mockResolvedValue(undefined);
    mocks.onDeploymentReady.mockResolvedValue(undefined);
    mocks.ensureRoutingReady.mockResolvedValue({ edgeDown: false });
    mocks.prepareTargetPinnedHostPorts.mockResolvedValue([]);
    mocks.allocateAndReservePinnedHostPort.mockImplementation(allocatePinnedHostPort);
    mocks.reserveTargetPinnedHostPort.mockImplementation(async (_target, claim) => claim);
    mocks.reserveVerifiedTargetPinnedHostPort.mockImplementation(async (_target, claim) => claim);
    mocks.convergeTargetHostPortClaims.mockResolvedValue({ released: 0, retained: [] });
    mocks.convergeTargetHostPortClaimsUnlocked.mockResolvedValue({ released: 0, retained: [] });

    const executor = {
      exec: vi.fn(async () => ""),
      readFile: vi.fn(async () => ""),
    };
    const system = { ensureFeature: vi.fn(async () => undefined) };

    vi.mocked(platform).mockReturnValue({
      target: "selfhosted",
      runtime: adapter,
      routing: { certificateManagement: "none" },
      ssl: { certificateManagement: "none" },
      system,
      executor,
      localHost: true,
    } as never);
    resolvedPlatform = {
      platform: {
        target: "selfhosted",
        runtime: adapter,
        routing: { certificateManagement: "none" },
        ssl: { certificateManagement: "none" },
        system,
        executor,
        localHost: true,
      },
      effectiveTarget: "local",
      serverId: null,
      hostPortTarget: { targetKey: "local", legacyTargetKeys: [], stable: true },
      runtimeMode: "docker",
      usesManagedRouting: true,
    } as never;
    vi.mocked(resolveDeploymentPlatform).mockResolvedValue(resolvedPlatform);
  });

  it.each([null, "workspace-1"])(
    "waits for pre-deploy backups before workspace admission or a prebuilt cutover (workspace: %s)",
    async (workspaceId) => {
      let finishBackup!: () => void;
      const backupFinished = new Promise<void>((resolve) => {
        finishBackup = resolve;
      });
      vi.mocked(firePreDeployBackups).mockImplementationOnce(async () => {
        await backupFinished;
        return { enqueued: 1, completed: 1 };
      });
      try {
        await run(deployment(), { workspaceId });
        await vi.waitFor(() => expect(firePreDeployBackups).toHaveBeenCalledOnce());
        // Waiting inside this lock strands the backup worker that needs it.
        expect(mocks.withWorkspaceActivity).not.toHaveBeenCalled();
        expect(mocks.prepareImage).not.toHaveBeenCalled();
        expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
        expect(mocks.deploy).not.toHaveBeenCalled();
        expect(mocks.destroy).not.toHaveBeenCalled();

        finishBackup();
        await drainDeploymentExecutions();
        expect(mocks.onSuccess).toHaveBeenCalledOnce();
        expect(mocks.deploy).toHaveBeenCalledOnce();
      } finally {
        finishBackup();
        await drainDeploymentExecutions();
      }
    },
  );

  it("fails before touching the running app when a pre-deploy backup fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(firePreDeployBackups).mockImplementationOnce(async (opts) => {
      opts.log?.("Backup bkr_db failed; deployment stopped.", "warn");
      throw new Error("Pre-deploy backup bkr_db failed");
    });
    try {
      await run();
      await drainDeploymentExecutions();
      expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("deployment-1", "failed", {
        errorMessage: "Pre-deploy backup bkr_db failed",
      });
      expect(mocks.updateBuildSession).toHaveBeenCalledWith("build-session-1", {
        status: "failed",
      });
      expect(mocks.updateBuildSession).toHaveBeenCalledWith("build-session-1", {
        logs: [
          expect.objectContaining({
            message: "Backup bkr_db failed; deployment stopped.",
            level: "warn",
          }),
        ],
      });
      expect(mocks.cancelPendingPrompt).toHaveBeenCalledWith("deployment-1");
      expect(mocks.withWorkspaceActivity).not.toHaveBeenCalled();
      expect(mocks.deploy).not.toHaveBeenCalled();
      expect(mocks.destroy).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.onSuccess).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("publishes the backup dialog before workspace admission and preserves the explicit bypass in build logs", async () => {
    const prompt = {
      promptId: "backup-1",
      title: "Backup failed",
      message: "Choose",
      actions: [{ id: "skip:1", label: "Continue without backup" }],
    };
    let answer!: (action: string) => void;
    mocks.promptUser.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    vi.mocked(firePreDeployBackups).mockImplementationOnce(async (opts) => {
      opts.log?.("Backup failed; waiting for a decision.", "warn");
      expect(await opts.promptUser!(prompt)).toBe("skip:1");
      opts.log?.("User chose Continue without backup.", "warn");
      return { enqueued: 1, completed: 0 };
    });
    await run();
    await vi.waitFor(() => expect(mocks.promptUser).toHaveBeenCalledWith("deployment-1", prompt));
    expect(mocks.withWorkspaceActivity).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.updateBuildSession).toHaveBeenCalledWith("build-session-1", {
      logs: [
        expect.objectContaining({
          message: "Backup failed; waiting for a decision.",
          level: "warn",
        }),
      ],
    });
    answer("skip:1");
    await drainDeploymentExecutions();
    expect(mocks.onSuccess).toHaveBeenCalledOnce();
    expect(mocks.onSuccess.mock.calls[0]![0].persistLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "User chose Continue without backup.", level: "warn" }),
      ]),
    );
    expect(mocks.cancelPendingPrompt).toHaveBeenCalledWith("deployment-1");
  });

  it("does not open a late backup prompt after cancellation while its logs are being saved", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let finishSave!: () => void;
    mocks.updateBuildSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    vi.mocked(firePreDeployBackups).mockImplementationOnce(async (opts) => {
      opts.log?.("Waiting for a backup decision.", "warn");
      await raceDeploymentCancellation(
        opts.promptUser!({
          promptId: "backup-1",
          title: "Backup failed",
          message: "Choose",
          actions: [],
        }),
        opts.signal,
      );
      return { enqueued: 1, completed: 0 };
    });
    try {
      await run();
      await vi.waitFor(() => expect(mocks.updateBuildSession).toHaveBeenCalled());
      requestDeploymentCancellation("deployment-1");
      await drainDeploymentExecutions();
      finishSave();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mocks.promptUser).not.toHaveBeenCalled();
      expect(mocks.cancelPendingPrompt).toHaveBeenCalledWith("deployment-1");
      expect(mocks.withWorkspaceActivity).not.toHaveBeenCalled();
      expect(mocks.deploy).not.toHaveBeenCalled();
    } finally {
      finishSave?.();
      log.mockRestore();
    }
  });

  it.each(["docker", "kubernetes"])("%s pulls the frozen image, skips source builds, and freezes the digest", async (runtimeName) => {
    resolvedRuntime.name = runtimeName;
    await run();
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledWith("build-session-1"),
    );

    expect(mocks.prepareImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "build-session-1",
        projectId: "project-1",
        slug: "release-app",
        imageRef: SOURCE_IMAGE,
        envVars: { API_TOKEN: "secret", PORT: "8080" },
        forcePull: true,
      }),
      expect.anything(),
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.resolveBuildGitToken).not.toHaveBeenCalled();
    expect(mocks.openDeployRelay).not.toHaveBeenCalled();

    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        imageRef: RESOLVED_IMAGE,
        prebuiltImage: true,
        startCommand: "",
        // The decrypted deployment snapshot is also the runtime payload; a
        // secret must not disappear after being used for image preparation.
        envVars: { API_TOKEN: "secret" },
      }),
      expect.any(Function),
    );
    expect(mocks.onSuccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metaPatch: expect.objectContaining({ releaseImageRef: RESOLVED_IMAGE }),
      }),
    );
  });

  it("runs the snapshot's commands with the candidate config before routing locks or activation", async () => {
    await run(deployment({ meta: { ...snapshot(), releaseCommands: ["migrate", "seed"] } }), {
      routeStrategy: "host-port", releaseCommands: ["different-project-setting"],
    });
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.runReleaseCommand.mock.calls.map(call => call[1])).toEqual(["migrate", "seed"]);
    expect(mocks.runReleaseCommand).toHaveBeenCalledWith(
      expect.objectContaining({ imageRef: RESOLVED_IMAGE, envVars: { API_TOKEN: "secret" } }),
      "migrate", expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.runReleaseCommand.mock.calls[0]![0]).toBe(mocks.deploy.mock.calls[0]![0]);
    expect(mocks.prepareImage.mock.invocationCallOrder[0]).toBeLessThan(mocks.runReleaseCommand.mock.invocationCallOrder[0]!);
    expect(mocks.runReleaseCommand.mock.invocationCallOrder[1]).toBeLessThan(mocks.withHostPortTargetLock.mock.invocationCallOrder[0]!);
    expect(mocks.withHostPortTargetLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.deploy.mock.invocationCallOrder[0]!);
  });

  it.each(["local", "server", "cloud"])("retires the old Docker container after a successful %s swap with snapshots enabled", async target => {
    const previous = deployment({ id: "previous-deployment", containerId: "old-container", status: "ready" });
    const next = deployment();
    mocks.findDeploymentById.mockImplementation(async id => id === "previous-deployment" ? previous : next);
    resolvedPlatform.effectiveTarget = target as never;
    vi.mocked(resolveDeploymentRuntime).mockResolvedValue({ runtime: resolvedRuntime } as never);
    const running = new Set(["old-container"]);
    mocks.deploy.mockImplementation(async () => {
      running.add("container-1");
      return { status: "success", containerId: "container-1" };
    });
    mocks.destroy.mockImplementation(async id => { running.delete(id); });
    mocks.runDeployPipeline.mockImplementation(runRealDeployPipeline);

    await kickoffBuild(project({ activeDeploymentId: "previous-deployment", defaultRollbackStrategy: "snapshot" }), next);
    await drainDeploymentExecutions();

    expect(mocks.onSuccess).toHaveBeenCalledOnce();
    expect(running).toEqual(new Set(["container-1"]));
    expect(mocks.destroy).toHaveBeenCalledExactlyOnceWith("old-container");
    expect(mocks.deploy.mock.invocationCallOrder[0]).toBeLessThan(mocks.destroy.mock.invocationCallOrder[0]!);
  });

  it("a release failure never activates the candidate or stops the existing app", async () => {
    mocks.runReleaseCommand.mockRejectedValueOnce(new Error("Database migration failed"));
    await run(deployment({ meta: { ...snapshot(), releaseCommands: ["migrate", "seed"] } }), {
      activeDeploymentId: "previous-deployment", routeStrategy: "host-port",
    });
    await vi.waitFor(() => expect(mocks.reportPipelineError).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.reportPipelineError).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining("Database migration failed"), expect.anything(), undefined,
    );
    expect(mocks.runReleaseCommand).toHaveBeenCalledOnce();
    expect(mocks.withHostPortTargetLock).not.toHaveBeenCalled();
    expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
  });

  it("cancels during release work without activation or a failure outcome", async () => {
    mocks.runReleaseCommand.mockImplementationOnce(async (_config, _command, _log, options) => {
      requestDeploymentCancellation("deployment-1");
      expect(options.signal.aborted).toBe(true);
      options.signal.throwIfAborted();
    });
    await run(deployment({ meta: { ...snapshot(), releaseCommands: ["migrate", "seed"] } }));
    await vi.waitFor(() => expect(mocks.onCancelled).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.runReleaseCommand).toHaveBeenCalledOnce();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.reportPipelineError).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("skips commands for an unpinned rollback rebuilt from source on Bare", async () => {
    resolvedRuntime.name = "bare";
    mocks.build.mockResolvedValueOnce({
      status: "deploying", imageRef: "/opt/openship/.builds/candidate", durationMs: 1,
    });
    await run(deployment({ trigger: "rollback", meta: {
      ...snapshot(), source: "git", build: "none", runtimeMode: "bare", releaseImageRef: undefined,
      releaseCommands: ["migrate"],
    } }));
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.runReleaseCommand).not.toHaveBeenCalled();
  });

  it("does not mistake a pinned artifact on a normal deployment for rollback", async () => {
    await run(deployment({ trigger: "redeploy", meta: {
      ...snapshot(), handoverAppImage: RESOLVED_IMAGE, releaseCommands: ["migrate"],
    } }));
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.runReleaseCommand).toHaveBeenCalledOnce();
  });

  it("refuses configured commands on an unsupported runtime", async () => {
    resolvedRuntime.supports = capability => capability !== "releaseCommand";
    await run(deployment({ meta: { ...snapshot(), releaseCommands: ["migrate"] } }));
    await vi.waitFor(() => expect(mocks.reportPipelineError).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.reportPipelineError).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining("cannot run release commands"), expect.anything(), undefined,
    );
    expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it("refuses project release commands before mutating a multi-service deployment", async () => {
    vi.mocked(shouldUseProjectServicePipeline).mockResolvedValue(true);
    vi.mocked(isMultiServiceRuntime).mockReturnValue(true);
    await run(deployment({ meta: {
      ...snapshot(), serviceDeploymentMode: "services", releaseCommands: ["migrate"],
      composeServices: [{ name: "db", image: "postgres:16", ports: [], dependsOn: [], environment: {}, volumes: [] }],
    } }));
    await vi.waitFor(() => expect(mocks.reportPipelineError).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.reportPipelineError).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining("not supported on multi-service deployments"), expect.anything(), undefined,
    );
    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    expect(mocks.runReleaseCommand).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it.each([true, false])("source services reach the shared builder with the resolved budget (Cloud mode: %s)", async (cloudMode) => {
    const originalCloudMode = env.CLOUD_MODE;
    Object.assign(env, { CLOUD_MODE: cloudMode });
    const resources = cloudMode
      ? { cpuCores: 1.5, memoryMb: 2800, diskMb: 25_600 }
      : { cpuCores: 0.5, memoryMb: 512, diskMb: 8192 };
    const services = ["api", "worker"].map(name => ({
      id: `svc-${name}`, name, kind: "compose", enabled: true,
      image: null, build: `./${name}`, dockerfile: "Dockerfile", advanced: {},
    }));
    vi.mocked(repos.service.listByProject).mockResolvedValue(services as never);
    vi.mocked(resolveProjectServicePreflightServices).mockResolvedValue(services as never);
    vi.mocked(shouldUseProjectServicePipeline).mockResolvedValue(true);
    vi.mocked(isMultiServiceRuntime).mockReturnValue(true);
    vi.mocked(resolveBuildResources).mockReturnValue(resources);
    mocks.sampleCloudWorkspaceResources.mockResolvedValue({
      capacity: { cpuCores: 2, memoryMb: 4000, diskMb: 25_600 },
      usage: { available: true, memoryAvailableMb: 3000, cpuPercent: 25 },
    });
    const buildImages = vi.fn(async (specs) => {
      for (const spec of specs) {
        spec.onResult({ status: "running", imageRef: `openship/test:${spec.serviceName}` });
      }
    });
    Object.assign(resolvedRuntime, { buildImages });
    vi.mocked(executeComposePipeline).mockImplementationOnce(async (options) => {
      const result = await buildComposeImages(options);
      expect(result.buildFailures.size).toBe(0);
      expect(result.builtImageRefs.size).toBe(2);
    });
    try {
      await run(deployment({ meta: {
        ...snapshot(), releaseImageRef: undefined, source: "git", build: "dockerfile",
        serviceDeploymentMode: "services", repoUrl: "https://github.com/acme/services",
        buildResources: cloudMode ? null : resources,
        ...(cloudMode ? { managedServer: { ownerWorkspaceId: "workspace-1" } } : {}),
        composeServices: services,
      } }));
      await drainDeploymentExecutions();
      expect(mocks.reportPipelineError).not.toHaveBeenCalled();
      expect(buildImages).toHaveBeenCalledOnce();
      expect(buildImages.mock.calls[0]![0].map((spec: { serviceName: string; config: { resources: unknown } }) => ({
        name: spec.serviceName, resources: spec.config.resources,
      }))).toEqual(services.map(service => ({ name: service.name, resources })));
      if (cloudMode) {
        expect(mocks.sampleCloudWorkspaceResources).toHaveBeenCalledExactlyOnceWith("org-1", "workspace-1");
      } else {
        expect(mocks.sampleCloudWorkspaceResources).not.toHaveBeenCalled();
      }
    } finally {
      Object.assign(env, { CLOUD_MODE: originalCloudMode });
      vi.mocked(resolveBuildResources).mockReturnValue({} as never);
    }
  });

  it("cancels the selected Docker builder and waits for its cleanup before releasing the deployment", async () => {
    const services = ["api", "web"].map(name => ({
      id: `svc-${name}`, name, kind: "compose", enabled: true,
      image: null, build: `./${name}`, dockerfile: "Dockerfile", advanced: {},
    }));
    vi.mocked(repos.service.listByProject).mockResolvedValue(services as never);
    vi.mocked(resolveProjectServicePreflightServices).mockResolvedValue(services as never);
    vi.mocked(shouldUseProjectServicePipeline).mockResolvedValue(true);
    vi.mocked(isMultiServiceRuntime).mockReturnValue(true);

    let finishBuild!: () => void;
    let finishCleanup!: () => void;
    const building = new Promise<void>(resolve => { finishBuild = resolve; });
    const cleaning = new Promise<void>(resolve => { finishCleanup = resolve; });
    const buildImages = vi.fn(async specs => {
      await building;
      for (const spec of specs) spec.onResult({ status: "cancelled" });
    });
    const cancelSelected = vi.fn(async () => {
      finishBuild();
      await cleaning;
    });
    Object.assign(resolvedRuntime, { buildImages, cancelBuild: cancelSelected });
    const cancelDefault = vi.fn();
    vi.mocked(platform).mockReturnValue({
      ...platform(), target: "desktop", runtime: { name: "bare", cancelBuild: cancelDefault },
    } as never);
    vi.mocked(executeComposePipeline).mockImplementationOnce(async options => {
      await buildComposeImages(options);
    });
    const dep = await run(deployment({ meta: {
      ...snapshot(), releaseImageRef: undefined, source: "git", build: "dockerfile",
      serviceDeploymentMode: "services", composeServices: services,
    } }));
    try {
      await vi.waitFor(() => expect(buildImages).toHaveBeenCalledOnce());
      Object.assign(dep, { status: "cancelled" });
      requestDeploymentCancellation("deployment-1");
      await vi.waitFor(() => expect(cancelSelected).toHaveBeenCalledExactlyOnceWith("build-session-1"));
      expect(cancelDefault).not.toHaveBeenCalled();
      expect(mocks.acknowledgeBuildExecutionFinished).not.toHaveBeenCalled();
      finishCleanup();
      await drainDeploymentExecutions();
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledExactlyOnceWith("build-session-1");
      expect(mocks.deploy).not.toHaveBeenCalled();
    } finally {
      finishBuild();
      finishCleanup();
      await drainDeploymentExecutions();
    }
  });

  it("refuses release commands on a static deployment before creating its runtime", async () => {
    await run(deployment({ meta: {
      ...snapshot(), workload: "static", hasServer: false, releaseCommands: ["migrate"],
    } }));
    await vi.waitFor(() => expect(mocks.reportPipelineError).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.reportPipelineError).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining("Static sites cannot run release commands"), expect.anything(), undefined,
    );
    expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
    expect(mocks.runReleaseCommand).not.toHaveBeenCalled();
  });

  it("refuses a cluster refresh with a missing digest instead of starting a source build", async () => {
    resolvedRuntime.name = "kubernetes";
    await run(deployment({ meta: {
      ...snapshot(), releaseImageRef: undefined, refreshAppDeploymentId: "old-deployment",
      handoverAppImage: "ghcr.io/acme/app:latest",
    } }));
    await vi.waitFor(() => expect(mocks.reportPipelineError).toHaveBeenCalledTimes(1));
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.prepareImage).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it("finishes cancellation after a database outage without releasing a live worker (#919)", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let finishPreparation!: () => void;
    const preparing = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let leaseOpen = true;
    mocks.hasLiveBuildExecution.mockImplementation(async () => leaseOpen);
    mocks.prepareImage.mockImplementationOnce(async () => {
      await preparing;
      throw new Error("Image preparation cancelled");
    });
    mocks.acknowledgeBuildExecutionFinished
      .mockRejectedValueOnce(new Error("Database connection lost"))
      .mockRejectedValueOnce(new Error("Database still unavailable"))
      .mockImplementationOnce(async () => {
        leaseOpen = false;
      });
    const dep = await run();
    const signal = registerDeploymentExecution("deployment-1");
    try {
      await vi.waitFor(() => expect(mocks.prepareImage).toHaveBeenCalledOnce());
      Object.assign(dep, { status: "cancelled" });
      requestDeploymentCancellation("deployment-1");
      let drained = false;
      const drain = drainDeploymentExecutions().then(() => {
        drained = true;
      });

      // Requesting cancellation is not permission to abandon a host operation.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.acknowledgeBuildExecutionFinished).not.toHaveBeenCalled();
      expect(drained).toBe(false);
      await expect(
        waitForDeploymentQuiescence("deployment-1", "project-1", { timeoutMs: 0 }),
      ).resolves.toBe(false);

      finishPreparation();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.onCancelled).toHaveBeenCalledOnce();
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();
      expect(drained).toBe(false);
      await expect(
        waitForDeploymentQuiescence("deployment-1", "project-1", { timeoutMs: 0 }),
      ).resolves.toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(leaseOpen).toBe(true);
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await drain;
      await expect(
        waitForDeploymentQuiescence("deployment-1", "project-1", { timeoutMs: 0 }),
      ).resolves.toBe(true);
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledTimes(3);
      expect(mocks.prepareImage).toHaveBeenCalledOnce();
      expect(mocks.onCancelled).toHaveBeenCalledOnce();
      expect(mocks.deploy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishPreparation();
      releaseDeploymentExecution("deployment-1", signal);
      vi.useRealTimers();
      log.mockRestore();
    }
  });

  it("does not execute a legacy queued preview against a production target (#195)", async () => {
    await expect(kickoffBuild(
      project({ environmentType: "production" }),
      deployment({ environment: "preview" }),
    )).rejects.toMatchObject({ code: "DEPLOYMENT_ENVIRONMENT_TARGET_MISMATCH" });

    expect(mocks.claimBuildExecution).not.toHaveBeenCalled();
    expect(mocks.prepareImage).not.toHaveBeenCalled();
    expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
  });

  it("does not start a worker when deletion or another kickoff owns the execution claim", async () => {
    mocks.claimBuildExecution.mockResolvedValue("state_changed");

    await expect(kickoffBuild(project(), deployment())).resolves.toBe("build-session-1");

    expect(mocks.prepareImage).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
    expect(mocks.acknowledgeBuildExecutionFinished).not.toHaveBeenCalled();
  });

  it("fails and releases the claimed build when the live session cache is full", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createSession.mockImplementationOnce(() => {
      throw new Error("Cache capacity reached; all entries are in use");
    });
    try {
      await run();
      await drainDeploymentExecutions();

      expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("deployment-1", "failed", {
        errorMessage: "Cache capacity reached; all entries are in use",
      });
      expect(mocks.updateBuildSession).toHaveBeenCalledWith("build-session-1", { status: "failed" });
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledWith("build-session-1");
      expect(requestDeploymentCancellation("deployment-1")).toBe(false);
      expect(mocks.prepareImage).not.toHaveBeenCalled();
      expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("inventories migrated edge routes before reserving a loopback host port", async () => {
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight(input.config, async () => "migrate");
      const result = await env.activate(input.config, () => undefined);
      return {
        status: "success",
        containerId: result.containerId,
        url: result.url,
      };
    });

    await run(deployment(), { routeStrategy: "loopback-port" });
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.ensureRoutingReady).toHaveBeenCalledTimes(1);
    expect(mocks.prepareTargetPinnedHostPorts).toHaveBeenCalledTimes(1);
    expect(mocks.allocateAndReservePinnedHostPort).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoutingReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareTargetPinnedHostPorts.mock.invocationCallOrder[0]!,
    );
    expect(mocks.prepareTargetPinnedHostPorts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.allocateAndReservePinnedHostPort.mock.invocationCallOrder[0]!,
    );
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ hostPort: 30_000 }),
      expect.any(Function),
    );
    expect(ensurePortAvailable).toHaveBeenCalledExactlyOnceWith(
      resolvedPlatform.platform.executor, 30_000, expect.anything(), expect.any(Function),
    );
    expect(mocks.convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        desiredPublishes: [{ serviceId: null, containerPort: 8080, hostPort: 30_000 }],
      }),
    );
    expect(mocks.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(mocks.deploy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.convergeTargetHostPortClaimsUnlocked.mock.invocationCallOrder[0]!,
    );
    expect(mocks.convergeTargetHostPortClaimsUnlocked.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onSuccess.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { routeStrategy: "container-ip", managed: true },
    { routeStrategy: "loopback-port", managed: false },
  ])(
    "does not confuse a Docker port with an occupied host port ($routeStrategy, managed=$managed)",
    async ({ routeStrategy, managed }) => {
      resolvedPlatform.usesManagedRouting = managed;
      vi.mocked(ensurePortAvailable).mockRejectedValue(new Error("Host port 80 belongs to the edge"));
      mocks.runDeployPipeline.mockImplementationOnce(runRealDeployPipeline);

      await run(deployment({ meta: { ...snapshot(), port: 80 } }), { routeStrategy });
      await drainDeploymentExecutions();

      expect(mocks.onSuccess).toHaveBeenCalledOnce();
      expect(mocks.deploy).toHaveBeenCalledOnce();
      expect(ensurePortAvailable).not.toHaveBeenCalled();
      expect(mocks.promptUser).not.toHaveBeenCalled();
    },
  );

  it("keeps the host-port conflict check for an unrouted Bare app", async () => {
    resolvedRuntime.name = "bare";
    resolvedPlatform.usesManagedRouting = false;
    vi.mocked(ensurePortAvailable).mockRejectedValue(new Error("Host port 8080 is occupied"));
    mocks.runDeployPipeline.mockImplementationOnce(runRealDeployPipeline);

    await run();
    await drainDeploymentExecutions();

    expect(ensurePortAvailable).toHaveBeenCalledExactlyOnceWith(
      resolvedPlatform.platform.executor, 8080, expect.anything(), expect.any(Function),
      { outgoingDeploymentId: undefined },
    );
    expect(mocks.onFailure).toHaveBeenCalledOnce();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
  });

  it("names the release a Bare redeploy replaces to the host-port check (#1038)", async () => {
    resolvedRuntime.name = "bare";
    resolvedPlatform.usesManagedRouting = false;
    const previous = deployment({ id: "previous-deployment", containerId: "old-unit", status: "ready" });
    const next = deployment();
    mocks.findDeploymentById.mockImplementation(async id => id === "previous-deployment" ? previous : next);
    vi.mocked(resolveDeploymentRuntime).mockResolvedValue({ runtime: resolvedRuntime } as never);
    vi.mocked(ensurePortAvailable).mockRejectedValue(new Error("Host port 8080 is occupied"));
    mocks.runDeployPipeline.mockImplementationOnce(runRealDeployPipeline);

    await kickoffBuild(project({ activeDeploymentId: "previous-deployment" }), next);
    await drainDeploymentExecutions();

    expect(ensurePortAvailable).toHaveBeenCalledExactlyOnceWith(
      resolvedPlatform.platform.executor, 8080, expect.anything(), expect.any(Function),
      { outgoingDeploymentId: "previous-deployment" },
    );
  });

  it("deploys an unrouted native app without reserving routed host ports or preparing an edge", async () => {
    resolvedRuntime.name = "bare";
    resolvedPlatform.platform = { ...resolvedPlatform.platform, target: "desktop" };
    resolvedPlatform.usesManagedRouting = false;
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight?.(input.config, async () => "migrate");
      return { status: "success", ...await env.activate(input.config, () => undefined) };
    });

    await run(deployment(), { routeStrategy: "loopback-port" });
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.withHostPortTargetLock).not.toHaveBeenCalled();
    expect(mocks.ensureRoutingReady).not.toHaveBeenCalled();
    expect(mocks.prepareTargetPinnedHostPorts).not.toHaveBeenCalled();
    expect(mocks.allocateAndReservePinnedHostPort).not.toHaveBeenCalled();
    expect(mocks.reserveTargetPinnedHostPort).not.toHaveBeenCalled();
    expect(mocks.deploy.mock.calls[0]![0].hostPort).toBeUndefined();
    expect(mocks.convergeTargetHostPortClaims).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", desiredPublishes: [] }),
    );
  });

  it("converges a container-IP transition to an empty desired set under its own target lock", async () => {
    await run();
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.convergeTargetHostPortClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        desiredPublishes: [],
      }),
    );
    expect(mocks.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
    expect(mocks.convergeTargetHostPortClaims.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onSuccess.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps a successful deploy ready and surfaces a deferred claim cleanup", async () => {
    mocks.convergeTargetHostPortClaims.mockRejectedValueOnce(new Error("edge scan unavailable"));

    await run();
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.onFailure).not.toHaveBeenCalled();
    expect(mocks.onSuccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        warningMessage: expect.stringContaining("Host-port reservation cleanup was deferred"),
      }),
    );
  });

  it("protects a bare explicit container-ip deploy from stale edge ports before activation", async () => {
    // Bare still binds the target host's loopback namespace. The user-facing
    // strategy cannot turn that physical topology into a container bridge.
    resolvedRuntime.name = "bare";
    mocks.prepareTargetPinnedHostPorts.mockResolvedValue([
      {
        id: "hpc_quarantine_20000",
        targetKey: "local",
        projectId: "__openship_host_port_quarantine__",
        serviceId: null,
        containerPort: null,
        port: 20_000,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]);
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight(input.config, async () => "migrate");
      const result = await env.activate(input.config, () => undefined);
      return {
        status: "success",
        containerId: result.containerId,
        url: result.url,
      };
    });

    await run(deployment(), { routeStrategy: "container-ip" });
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.withHostPortTargetLock).toHaveBeenCalledTimes(1);
    expect(mocks.prepareTargetPinnedHostPorts).toHaveBeenCalledTimes(1);
    expect(mocks.allocateAndReservePinnedHostPort).not.toHaveBeenCalled();
    expect(mocks.reserveTargetPinnedHostPort).toHaveBeenCalledWith(
      { targetKey: "local", legacyTargetKeys: [], stable: true },
      {
        projectId: "project-1",
        serviceId: null,
        containerPort: 8080,
        port: 8080,
      },
    );
    expect(mocks.prepareTargetPinnedHostPorts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserveTargetPinnedHostPort.mock.invocationCallOrder[0]!,
    );
    expect(mocks.reserveTargetPinnedHostPort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploy.mock.invocationCallOrder[0]!,
    );
  });

  it("validates the live route target against its durable owner before cutover", async () => {
    mocks.getContainerInfo.mockResolvedValue({
      ipAddress: "172.18.0.2",
      hostPort: 30_000,
    });
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight(input.config, async () => "migrate");
      const result = await env.activate(input.config, () => undefined);
      const targetUrl = await env.resolveTargetUrl(result.containerId, input.config.port);
      return {
        status: "success",
        containerId: result.containerId,
        url: targetUrl,
      };
    });

    await run(deployment(), { routeStrategy: "loopback-port" });
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));

    expect(mocks.reserveVerifiedTargetPinnedHostPort).toHaveBeenCalledWith(
      { targetKey: "local", legacyTargetKeys: [], stable: true },
      {
        projectId: "project-1",
        serviceId: null,
        containerPort: 8080,
        port: 30_000,
      },
      expect.any(Function),
    );
    expect(mocks.allocateAndReservePinnedHostPort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserveVerifiedTargetPinnedHostPort.mock.invocationCallOrder[0]!,
    );
  });

  it("resolves a managed bare process through provider routing without self-hosted edge claims", async () => {
    resolvedRuntime.name = "bare";
    resolvedRuntime.getContainerIp = async () => "127.0.0.1";
    resolvedPlatform.effectiveTarget = "cloud";
    resolvedPlatform.runtimeMode = "bare";
    resolvedPlatform.hostPortTarget = null;
    mocks.build.mockResolvedValueOnce({
      status: "deploying", imageRef: "/opt/openship/.builds/candidate", durationMs: 1,
    });
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight(input.config, async () => "migrate");
      const result = await env.activate(input.config, () => undefined);
      const targetUrl = await env.resolveTargetUrl(result.containerId, input.config.port);
      return { status: "success", containerId: result.containerId, url: targetUrl };
    });

    await run(deployment({ meta: {
      ...snapshot(), source: "git", build: "none", runtimeMode: "bare", releaseImageRef: undefined,
    } }));
    await drainDeploymentExecutions();

    expect(mocks.reportPipelineError).not.toHaveBeenCalled();
    expect(mocks.onSuccess).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ url: "http://127.0.0.1:8080" }),
    );
    expect(mocks.withHostPortTargetLock).not.toHaveBeenCalled();
    expect(mocks.prepareTargetPinnedHostPorts).not.toHaveBeenCalled();
    expect(mocks.reserveVerifiedTargetPinnedHostPort).not.toHaveBeenCalled();
  });

  it("cannot start a managed deployment cancelled while it waited for the server", async () => {
    mocks.withWorkspaceActivity.mockImplementationOnce(async (_id, work) => {
      mocks.findDeploymentById.mockResolvedValue(deployment({ status: "cancelled" }));
      return work();
    });
    await run(deployment(), { workspaceId: "managed-server" });
    await drainDeploymentExecutions();
    expect(mocks.prepareImage).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
    expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledWith("build-session-1");
  });

  it("does not reclaim the foreign Docker image when deployment fails after preparation", async () => {
    mocks.runDeployPipeline.mockResolvedValue({ status: "failed", error: "route failed" });

    await run();
    await vi.waitFor(() => expect(mocks.onFailure).toHaveBeenCalledTimes(1));

    const lifecycleContext = mocks.onFailure.mock.calls[0]?.[0];
    expect(lifecycleContext.provisioned).toEqual({});
    expect(mocks.destroy).not.toHaveBeenCalledWith(RESOLVED_IMAGE);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(mocks.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });

  it("strictly converges a fresh failed-attempt claim only after workload cleanup", async () => {
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight(input.config, async () => "migrate");
      const activated = await env.activate(input.config, () => undefined);
      return {
        status: "failed",
        containerId: activated.containerId,
        error: "health check failed",
      };
    });

    await run(deployment(), { routeStrategy: "loopback-port" });
    await vi.waitFor(() => expect(mocks.onFailure).toHaveBeenCalledTimes(1));

    expect(mocks.destroy).toHaveBeenCalledWith("container-1");
    expect(mocks.convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        desiredPublishes: [],
      }),
    );
    expect(mocks.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.convergeTargetHostPortClaimsUnlocked.mock.invocationCallOrder[0]!,
    );
  });

  it("retains a fresh failed-attempt claim when workload cleanup fails", async () => {
    mocks.destroy.mockRejectedValueOnce(new Error("daemon unavailable"));
    mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
      await env.preflight(input.config, async () => "migrate");
      const activated = await env.activate(input.config, () => undefined);
      return {
        status: "failed",
        containerId: activated.containerId,
        error: "health check failed",
      };
    });

    await run(deployment(), { routeStrategy: "loopback-port" });
    await vi.waitFor(() => expect(mocks.onFailure).toHaveBeenCalledTimes(1));

    expect(mocks.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(mocks.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });

  it("does not reclaim or deploy the foreign Docker image when preparation is cancelled", async () => {
    mocks.prepareImage.mockResolvedValue({
      sessionId: "build-session-1",
      status: "cancelled",
      imageRef: RESOLVED_IMAGE,
      durationMs: 4,
      artifactOwned: false,
    });

    await run(deployment({ trigger: "manual" }));
    await vi.waitFor(() => expect(mocks.onCancelled).toHaveBeenCalledTimes(1));

    const lifecycleContext = mocks.onCancelled.mock.calls[0]?.[0];
    expect(lifecycleContext.provisioned).toEqual({});
    expect(mocks.destroy).not.toHaveBeenCalledWith(RESOLVED_IMAGE);
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.runDeployPipeline).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  // A server (remote/SSH) deploy target skipped the TCP/HTTP readiness probe
  // for a running-process app: the strategy never declared
  // `readinessWorksRemotely`, so `onFailure: "fail"` was never consulted for
  // it, even with a probe failure the app genuinely had. These tests call
  // `env.healthCheck` directly — the exact field build-pipeline.ts wires the
  // readiness gate through — rather than re-deriving the decision by hand, so
  // a regression in the real wiring fails here, not just in a stand-in.
  describe("readiness gate wiring for a server deploy target", () => {
    // Polling can retry before the deadline. Assert the destination and verdict,
    // rather than an attempt count that depends on timer scheduling.
    function serverExecutor(forwardPort: () => Promise<never>) {
      return { exec: vi.fn(async () => ""), forwardPort: vi.fn(forwardPort) };
    }

    function useTarget(effectiveTarget: string, executor: { forwardPort?: unknown; exec?: unknown } | null) {
      resolvedPlatform.effectiveTarget = effectiveTarget as never;
      resolvedPlatform.platform = { ...resolvedPlatform.platform, executor } as never;
    }

    type CapturedEnvironment = {
      env: { healthCheck?: (id: string, cfg: unknown) => Promise<void> };
      containerId: string;
      config: unknown;
    };

    /** Runs kickoffBuild, capturing the real DeployEnvironment build-pipeline.ts builds. */
    async function captureEnvironment(readiness: Record<string, unknown>) {
      let captured: CapturedEnvironment | undefined;
      mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
        const result = await env.activate(input.config, () => undefined);
        captured = { env, containerId: result.containerId, config: input.config };
        return { status: "success", containerId: result.containerId, url: result.url };
      });
      await run(deployment(), { readiness });
      await vi.waitFor(() => expect(captured).toBeDefined());
      return captured!;
    }

    it('rejects through the server target\'s own executor when onFailure is "fail"', async () => {
      const forwardPort = vi.fn(async () => {
        throw Object.assign(new Error("(SSH) Channel open failure: Connection refused"), {
          reason: 2,
        });
      });
      useTarget("server", serverExecutor(forwardPort));

      const { env, containerId, config } = await captureEnvironment({
        enabled: true,
        onFailure: "fail",
        stabilization: false,
        timeoutSeconds: 0.01,
      });

      await expect(env.healthCheck!(containerId, config)).rejects.toThrow(/never answered/);
      expect(forwardPort).toHaveBeenCalledWith("172.18.0.2", 8080);
      expect(mocks.sshWithHostExecutor).not.toHaveBeenCalled();
    });

    it.each(["docker", "bare"])("enforces a managed %s app's HTTP gate through its server", async (mode) => {
      resolvedRuntime.name = mode;
      const exec = vi.fn(async () => "OPENSHIP_PROBE 503 1");
      useTarget("cloud", { exec });
      const { env, containerId, config } = await captureEnvironment({
        enabled: true, onFailure: "fail", stabilization: false,
        timeoutSeconds: 0.01, path: "/ready",
      });

      await expect(env.healthCheck!(containerId, config)).rejects.toThrow(/never answered/);
      expect(exec).toHaveBeenCalledWith(expect.stringContaining("/ready'"), expect.anything());
      expect(mocks.sshWithHostExecutor).not.toHaveBeenCalled();
    });

    it("keeps a healthy app unverified when its SSH control connection is unavailable", async () => {
      const { createServer } = await import("node:http");
      const server = createServer((_request, response) => {
        response.writeHead(200);
        response.end("healthy");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as { port: number }).port;
        expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
        mocks.getContainerInfo.mockResolvedValue({ status: "running", hostPort: port });
        const forwardPort = vi.fn(async () => {
          throw Object.assign(new Error("SSH connection lost: read ECONNRESET"), {
            code: "ECONNRESET",
            level: "client-socket",
          });
        });
        useTarget("server", serverExecutor(forwardPort));
        const { env, containerId, config } = await captureEnvironment({
          enabled: true,
          onFailure: "fail",
          stabilization: false,
          timeoutSeconds: 0.01,
          path: "/ready",
        });

        await expect(env.healthCheck!(containerId, config)).resolves.toBeUndefined();
        expect(forwardPort).toHaveBeenCalledExactlyOnceWith("127.0.0.1", port);
        expect(mocks.sshWithHostExecutor).not.toHaveBeenCalled();
        expect(mocks.appendLog).toHaveBeenCalledWith(
          "deployment-1",
          expect.objectContaining({
            level: "warn",
            message: expect.stringMatching(/Health check SKIPPED:.*ECONNRESET.*unverified/s),
          }),
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('warns instead of failing the deploy when onFailure is "warn"', async () => {
      const forwardPort = vi.fn(async () => {
        throw Object.assign(new Error("(SSH) Channel open failure: Connection refused"), {
          reason: 2,
        });
      });
      useTarget("server", serverExecutor(forwardPort));

      const { env, containerId, config } = await captureEnvironment({
        enabled: true,
        onFailure: "warn",
        stabilization: false,
        timeoutSeconds: 0.01,
      });

      await expect(env.healthCheck!(containerId, config)).resolves.toBeUndefined();
      expect(forwardPort).toHaveBeenCalledWith("172.18.0.2", 8080);
      expect(mocks.appendLog).toHaveBeenCalledWith(
        "deployment-1",
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("health check is set to warn"),
        }),
      );
    });

    it("wires no health check for a server target when the project has not enabled probing", async () => {
      useTarget("server", serverExecutor(vi.fn()));

      const { env } = await captureEnvironment({ enabled: false });

      expect(env.healthCheck).toBeUndefined();
    });

    it.each(["cloud", "cluster"])(
      "stays excluded for a %s target even with probing enabled",
      async (target) => {
        // Missing a remote execution channel must never fall back to the controller.
        useTarget(target, null);

        const { env, containerId, config } = await captureEnvironment({
          enabled: true,
          onFailure: "fail",
          stabilization: false,
          timeoutSeconds: 0.01,
        });

        await expect(env.healthCheck!(containerId, config)).resolves.toBeUndefined();
        expect(mocks.sshWithHostExecutor).not.toHaveBeenCalled();
      },
    );
  });
});

describe("managed server pipeline selection", () => {
  it("uses the single-app pipeline for a single container on a shared server", async () => {
    await expect(resolveServicePipelineMode(project({ workspaceId: "managed-a", serverId: "server-a" }), snapshot() as never))
      .resolves.toMatchObject({ useSingleAppPipeline: true, useServicePipeline: false });
    expect(mocks.findCloudDockerBinding).not.toHaveBeenCalled();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/platform-config", () => ({ platform: vi.fn() }));

vi.mock("@repo/platform/engine/lib/resource-access", () => ({ platform: vi.fn() }));
