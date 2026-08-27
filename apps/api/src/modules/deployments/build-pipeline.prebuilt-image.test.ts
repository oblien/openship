import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBuildSessionByDeploymentId: vi.fn(),
  claimBuildExecution: vi.fn(),
  cancelUnclaimedBuild: vi.fn(),
  acknowledgeBuildExecutionFinished: vi.fn(),
  updateDeploymentStatus: vi.fn(),
  updateBuildSession: vi.fn(),
  findDeploymentById: vi.fn(),
  prepareImage: vi.fn(),
  build: vi.fn(),
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
  appendLog: vi.fn(),
  ensureRoutingReady: vi.fn(),
  prepareTargetPinnedHostPorts: vi.fn(),
  allocateAndReservePinnedHostPort: vi.fn(),
  reserveTargetPinnedHostPort: vi.fn(),
  convergeTargetHostPortClaims: vi.fn(),
  convergeTargetHostPortClaimsUnlocked: vi.fn(),
  withHostPortTargetLock: vi.fn((_target, fn: () => unknown) => fn()),
}));

vi.mock("@repo/db", () => ({
  schema: {},
  repos: {
    deployment: {
      findBuildSessionByDeploymentId: (...args: unknown[]) =>
        mocks.findBuildSessionByDeploymentId(...args),
      claimBuildExecution: (...args: unknown[]) => mocks.claimBuildExecution(...args),
      cancelUnclaimedBuild: (...args: unknown[]) => mocks.cancelUnclaimedBuild(...args),
      acknowledgeBuildExecutionFinished: (...args: unknown[]) =>
        mocks.acknowledgeBuildExecutionFinished(...args),
      updateStatus: (...args: unknown[]) => mocks.updateDeploymentStatus(...args),
      updateBuildSession: (...args: unknown[]) => mocks.updateBuildSession(...args),
      findById: (...args: unknown[]) => mocks.findDeploymentById(...args),
    },
    service: {
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
    BareRuntime: class BareRuntime {},
    DockerRuntime: class DockerRuntime {},
    CloudRuntime: class CloudRuntime {},
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

vi.mock("../../lib/deployment-runtime", () => ({
  disposeRuntime: vi.fn(),
  resolveDeploymentRuntime: vi.fn(),
  resolveDeploymentPlatform: vi.fn(),
  resolveEffectiveTarget: vi.fn(() => "local"),
  hostChannelDeployNotice: vi.fn(() => null),
}));

vi.mock("../domains/project-route.service", () => ({
  resolveProjectRouteState: vi.fn(async () => ({
    publicEndpoints: [],
    primarySlug: "release-app",
  })),
}));

vi.mock("../github/clone-auth", () => ({
  cloneOnServerAvailable: vi.fn(() => ({ available: false })),
  resolveBuildGitToken: (...args: unknown[]) => mocks.resolveBuildGitToken(...args),
}));

vi.mock("../../lib/git-forwarding", () => ({
  openDeployRelay: (...args: unknown[]) => mocks.openDeployRelay(...args),
}));

vi.mock("../../lib/org-actor", () => ({ resolveOrgOwner: vi.fn(async () => null) }));
vi.mock("../settings/settings.service", () => ({
  resolveStrategy: vi.fn(async () => "server"),
}));
vi.mock("../../lib/encryption", () => ({
  decryptEnvMap: (env: Record<string, string>) => env,
}));
vi.mock("../../lib/resources", () => ({
  resolveRuntimeResources: vi.fn(() => ({})),
  resolveBuildResources: vi.fn(() => ({})),
}));
vi.mock("../../lib/request-context", () => ({ buildBackgroundContext: vi.fn(() => ({})) }));

vi.mock("./session-manager", () => ({
  createSession: vi.fn(),
  appendLog: (...args: unknown[]) => mocks.appendLog(...args),
  updateStatus: vi.fn(),
  promptUser: vi.fn(),
  endSession: vi.fn(),
}));

vi.mock("./service-checks", () => ({
  preCreateServiceDeployments: vi.fn(async () => new Map()),
  emitServiceCheckRun: vi.fn(async () => undefined),
  emitInitialServiceChecks: vi.fn(async () => undefined),
  rollupDeploymentStatus: vi.fn(() => "ready"),
}));

vi.mock("./compose", () => ({
  executeComposePipeline: vi.fn(),
  resolveProjectServicePreflightServices: vi.fn(async () => []),
  shouldUseProjectServicePipeline: vi.fn(async () => false),
}));

vi.mock("../backups/triggers/pre-deploy", () => ({
  firePreDeployBackups: vi.fn(async () => ({ enqueued: 0, failed: 0 })),
}));

vi.mock("./deployment-lifecycle", () => ({
  onFailure: (...args: unknown[]) => mocks.onFailure(...args),
  onSuccess: (...args: unknown[]) => mocks.onSuccess(...args),
  onCancelled: (...args: unknown[]) => mocks.onCancelled(...args),
  reportPipelineError: (...args: unknown[]) => mocks.reportPipelineError(...args),
  setDeploymentStatus: (...args: unknown[]) => mocks.setDeploymentStatus(...args),
  routeIssuesWarning: vi.fn(() => "routing warning"),
}));

vi.mock("./rollback", () => ({
  onDeploymentReady: (...args: unknown[]) => mocks.onDeploymentReady(...args),
}));

vi.mock("../../lib/routing-domains", () => ({
  auditRoutedDomainTls: vi.fn(async () => []),
  buildProjectRouteDomains: vi.fn(() => []),
  createTrackedSslProvider: vi.fn((ssl) => ssl),
  ensureRouteDomainRecord: vi.fn(),
  toRoutedDomainInputs: vi.fn(() => []),
  withEnsuredDomainRecord: vi.fn((route) => route),
}));

vi.mock("../../lib/openship-manifest-sync", () => ({
  syncProjectToServerManifest: vi.fn(async () => undefined),
}));
vi.mock("./attach-linked-networks", () => ({ attachLinkedNetworks: vi.fn(async () => undefined) }));
vi.mock("./port-audit.service", () => ({ auditPorts: vi.fn(async () => []) }));
vi.mock("./stability-audit.service", () => ({ verifyDeployedContainers: vi.fn(async () => []) }));
vi.mock("./readiness-gate", () => ({
  resolveReadinessGate: vi.fn(() => ({ active: false })),
  runReadinessGate: vi.fn(),
}));
vi.mock("./output-audit.service", () => ({
  auditStaticOutput: vi.fn(async () => []),
  describeOutputFinding: vi.fn(() => ""),
  outputFindingIsBroken: vi.fn(() => false),
  staticOutputTargets: vi.fn(() => []),
}));
vi.mock("../../lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes: vi.fn(async () => ({ failures: [] })),
  edgeUnsyncedWarning: vi.fn(() => ""),
}));
vi.mock("../../lib/project-routing-fields", () => ({
  compileProjectRoutingFields: vi.fn(() => ({})),
}));
vi.mock("../../lib/edge-challenge", () => ({ ensureEdgeChallengeReady: vi.fn() }));
vi.mock("../../lib/edge-vhost-repair", () => ({ repairEdgeVhosts: vi.fn() }));
vi.mock("../../lib/edge-reconcile", () => ({
  ensureRoutingReady: (...args: unknown[]) => mocks.ensureRoutingReady(...args),
}));
vi.mock("../../lib/acme-config", () => ({ resolveAcmeProviderOptions: vi.fn(() => ({})) }));
vi.mock("../../lib/ssh-manager", () => ({ sshManager: {} }));
vi.mock("./pinned-host-ports", () => ({
  listTargetPinnedHostPorts: vi.fn(async () => []),
  prepareTargetPinnedHostPorts: (...args: unknown[]) => mocks.prepareTargetPinnedHostPorts(...args),
  allocateAndReservePinnedHostPort: (...args: unknown[]) =>
    mocks.allocateAndReservePinnedHostPort(...args),
  releaseNewPinnedHostPortClaims: vi.fn(async () => 0),
  findOwnedPinnedHostPort: vi.fn(() => undefined),
  reserveTargetPinnedHostPort: (...args: unknown[]) => mocks.reserveTargetPinnedHostPort(...args),
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

import { platform } from "../../lib/controller-helpers";
import { resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { kickoffBuild } from "./build-pipeline";

const SOURCE_IMAGE = "ghcr.io/acme/release-app:v1.2.3";
const RESOLVED_IMAGE = "ghcr.io/acme/release-app@sha256:abc123";

function runtime() {
  return {
    name: "docker",
    capabilities: new Set(["prebuiltImage", "deploy", "containerIp"]),
    supports: (capability: string) =>
      capability === "prebuiltImage" || capability === "deploy" || capability === "containerIp",
    prepareImage: (...args: unknown[]) => mocks.prepareImage(...args),
    build: (...args: unknown[]) => mocks.build(...args),
    deploy: (...args: unknown[]) => mocks.deploy(...args),
    destroy: (...args: unknown[]) => mocks.destroy(...args),
    stop: (...args: unknown[]) => mocks.stop(...args),
    start: (...args: unknown[]) => mocks.start(...args),
    getContainerInfo: (...args: unknown[]) => mocks.getContainerInfo(...args),
    getContainerIp: async () => "172.18.0.2",
  };
}

let resolvedRuntime: ReturnType<typeof runtime>;

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
    const adapter = runtime();
    resolvedRuntime = adapter;

    mocks.findBuildSessionByDeploymentId.mockResolvedValue({ id: "build-session-1" });
    mocks.claimBuildExecution.mockResolvedValue("claimed");
    mocks.cancelUnclaimedBuild.mockResolvedValue(true);
    mocks.acknowledgeBuildExecutionFinished.mockResolvedValue(undefined);
    mocks.updateDeploymentStatus.mockResolvedValue(undefined);
    mocks.updateBuildSession.mockResolvedValue(undefined);
    mocks.setDeploymentStatus.mockResolvedValue(undefined);
    mocks.getContainerInfo.mockResolvedValue({ ipAddress: "172.18.0.2" });
    mocks.destroy.mockResolvedValue(undefined);
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
      routing: null,
      ssl: null,
      system,
      executor,
      localHost: true,
    } as never);
    vi.mocked(resolveDeploymentPlatform).mockResolvedValue({
      platform: {
        target: "selfhosted",
        runtime: adapter,
        routing: null,
        ssl: null,
        system,
        executor,
        localHost: true,
      },
      effectiveTarget: "local",
      serverId: null,
      hostPortTarget: { targetKey: "local", legacyTargetKeys: [], stable: true },
      runtimeMode: "docker",
      usesManagedRouting: false,
    } as never);
  });

  it("pulls the frozen image, skips every source-build path, deploys it as prebuilt, and freezes the digest", async () => {
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

  it("does not start a worker when deletion or another kickoff owns the execution claim", async () => {
    mocks.claimBuildExecution.mockResolvedValue("state_changed");

    await expect(kickoffBuild(project(), deployment())).resolves.toBe("build-session-1");

    expect(mocks.prepareImage).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
    expect(mocks.acknowledgeBuildExecutionFinished).not.toHaveBeenCalled();
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

    expect(mocks.reserveTargetPinnedHostPort).toHaveBeenCalledWith(
      { targetKey: "local", legacyTargetKeys: [], stable: true },
      {
        projectId: "project-1",
        serviceId: null,
        containerPort: 8080,
        port: 30_000,
      },
    );
    expect(mocks.allocateAndReservePinnedHostPort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserveTargetPinnedHostPort.mock.invocationCallOrder[0]!,
    );
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
});
