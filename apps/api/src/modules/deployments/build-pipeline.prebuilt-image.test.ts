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
  findProjectById: vi.fn(),
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
  getSession: vi.fn(),
  appendLog: vi.fn(),
  promptUser: vi.fn(),
  cancelPendingPrompt: vi.fn(),
  ensureRoutingReady: vi.fn(),
  prepareTargetPinnedHostPorts: vi.fn(),
  allocateAndReservePinnedHostPort: vi.fn(),
  suggestAlternativePinnedHostPort: vi.fn(),
  reserveTargetPinnedHostPort: vi.fn(),
  reserveVerifiedTargetPinnedHostPort: vi.fn(),
  convergeTargetHostPortClaims: vi.fn(),
  convergeTargetHostPortClaimsUnlocked: vi.fn(),
  withHostPortTargetLock: vi.fn((_target, fn: () => unknown) => fn()),
  withWorkspaceActivity: vi.fn(),
  sshWithHostExecutor: vi.fn(),
  sampleCloudWorkspaceResources: vi.fn(),
  drainQueue: vi.fn(),
  cancelReservation: vi.fn(),
  admitQueue: vi.fn(),
  deferUnactivatedCloudBuild: vi.fn(),
  activityGate: vi.fn(),
  sessionUpdateStatus: vi.fn(),
  reconcileRetention: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  // The real provision-lock still supplies in-process keyed serialization.
  withAdvisoryLock: <T>(_key: string, work: () => Promise<T>) => work(),
  runOutsideAdvisoryLock: <T>(work: () => T) => work(),
  schema: {},
  repos: {
    pullRequestPreview: { findByProject: vi.fn(async () => undefined) },
  routeProtection: { readPrivate: vi.fn(async () => null) },
    cloudBuildActivity: { cancelReservation: mocks.cancelReservation },
    cloudDockerWorkspace: { find: (...args: unknown[]) => mocks.findCloudDockerBinding(...args) },
    deployment: {
      listPendingRoleHandovers: async () => [],
      setRoleHandover: async () => {},
      findBuildSessionByDeploymentId: (...args: unknown[]) =>
        mocks.findBuildSessionByDeploymentId(...args),
      claimBuildExecution: (...args: unknown[]) => mocks.claimBuildExecution(...args),
      deferUnactivatedCloudBuild: mocks.deferUnactivatedCloudBuild,
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
    project: { findById: mocks.findProjectById, update: vi.fn(async () => undefined) },
  },
}));

vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  runOutsideCloudWorkspaceActivity: <T>(work: () => T) => work(),
  withCloudWorkspaceActivity: (...args: unknown[]) => mocks.withWorkspaceActivity(...args),
}));

vi.mock("@repo/platform/engine/lib/cloud-build-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/cloud-build-activity")>();
  const { cloudBuildActivityContext } = await import("@repo/platform/engine/lib/cloud-build-activity-context");
  return {
    ...actual,
    // Keep real AsyncLocalStorage detachment; fake only durable activity I/O.
    withCloudBuildActivity: (identity: any, work: () => Promise<unknown>) =>
      cloudBuildActivityContext.run({ identity, ownerToken: "test-owner", active: true }, () => mocks.activityGate(work)),
    releaseCloudBuildSlot: vi.fn(async () => {}),
  };
});
vi.mock("@repo/platform/engine/modules/deployments/cloud-build-queue", () => ({
  admitCloudBuild: mocks.admitQueue,
  drainCloudBuildQueue: mocks.drainQueue,
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
    DockerRuntime: class DockerRuntime {
      // This suite observes artifact/retirement behavior, not Docker identities.
      static deploymentContainerName() {
        return "mock-container";
      }
    },
    CloudRuntime: class CloudRuntime {},
    CloudDockerRuntime: class CloudDockerRuntime {},
    STATIC_RELEASE_BASE: "/opt/openship/static/releases",
    sharedMountExecutor: vi.fn(async () => null),
    resolveStaticOutputPath: (id: string) => id,
    ensurePortAvailable: vi.fn(async () => undefined),
    isDockerHostPortAvailable: vi.fn(async () => true),
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
    EdgeProxyProtocolConfigError: class EdgeProxyProtocolConfigError extends Error {},
    EdgeConfigRecoveryError: class EdgeConfigRecoveryError extends Error {},
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
  getSession: mocks.getSession,
  appendLog: (...args: unknown[]) => mocks.appendLog(...args),
  updateStatus: mocks.sessionUpdateStatus,
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
  beginBuildTiming: vi.fn(),
  completeBuildTiming: vi.fn(),
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
  reconcileProjectRetentionSafe: mocks.reconcileRetention,
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
vi.mock("@repo/platform/engine/lib/edge-vhost-repair", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/edge-vhost-repair")>()),
  repairEdgeVhosts: vi.fn(),
}));
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
  suggestAlternativePinnedHostPort: (...args: unknown[]) =>
    mocks.suggestAlternativePinnedHostPort(...args),
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

import { repos, type Deployment } from "@repo/db";
import {
  EdgeConfigRecoveryError,
  EdgeProxyProtocolConfigError,
  ensurePortAvailable,
  isMultiServiceRuntime,
} from "@repo/adapters";
import { firePreDeployBackups } from "@repo/platform/engine/modules/backups/triggers/pre-deploy";
import { ensureEdgeChallengeReady } from "@repo/platform/engine/lib/edge-challenge";
import { repairEdgeVhosts } from "@repo/platform/engine/lib/edge-vhost-repair";
import { executeComposePipeline, resolveProjectServicePreflightServices, shouldUseProjectServicePipeline } from "@repo/platform/engine/modules/deployments/compose/index";
import { CloudBuildAdmissionDeferredError, releaseCloudBuildSlot, runOutsideCloudBuildActivity } from "@repo/platform/engine/lib/cloud-build-activity";
import { AppError } from "@repo/core";
import { cloudBuildActivityContext } from "@repo/platform/engine/lib/cloud-build-activity-context";
import { buildComposeImages } from "@repo/platform/engine/modules/deployments/compose/build.service";
import { resolveBuildResources } from "@repo/platform/engine/lib/resources";
import { env } from "@repo/platform/engine/config/index";
import { platform } from "@repo/platform/engine/lib/platform-config";
import { resolveDeploymentPlatform, resolveDeploymentRuntime } from "@repo/platform/engine/lib/deployment-runtime";
import { runDeployPipeline as runRealDeployPipeline } from "../../../../../packages/adapters/src/runtime/deploy-pipeline";
import {
  buildProjectRouteDomains,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
} from "@repo/platform/engine/lib/routing-domains";
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
    supports(capability: string): boolean {
      return capability === "prebuiltImage" || capability === "deploy" || capability === "containerIp" || capability === "releaseCommand" ||
        (capability === "dockerHost" && this.name === "docker") ||
        (capability === "clusterStatus" && ["kubernetes", "swarm"].includes(this.name));
    },
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

function deployment(overrides: Record<string, unknown> = {}): Deployment {
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
  } as Deployment;
}

async function run(dep = deployment(), projectOverrides: Record<string, unknown> = {}) {
  mocks.findDeploymentById.mockResolvedValue(dep);
  const currentProject = project(projectOverrides);
  mocks.findProjectById.mockResolvedValue(currentProject);
  const sessionId = await kickoffBuild(currentProject, dep);
  expect(sessionId).toBe("build-session-1");
  return dep;
}

describe("single-app prebuilt release-image pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drainQueue.mockReset().mockResolvedValue({ started: 0 });
    mocks.cancelReservation.mockReset().mockResolvedValue(false);
    mocks.getSession.mockReset().mockReturnValue(undefined);
    mocks.deferUnactivatedCloudBuild.mockReset().mockResolvedValue(false);
    mocks.activityGate.mockReset().mockImplementation(async work => work());
    mocks.sessionUpdateStatus.mockReset();
    mocks.reconcileRetention.mockReset().mockResolvedValue(undefined);
    mocks.admitQueue.mockReset().mockImplementation(async (_project, _dep, start) => start(null));
    vi.mocked(releaseCloudBuildSlot).mockReset().mockResolvedValue(undefined);
    vi.mocked(ensurePortAvailable).mockReset().mockResolvedValue(undefined);
    mocks.suggestAlternativePinnedHostPort.mockReset().mockResolvedValue(null);
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

  it.each([false, true])("routes a hostname verified during the first build and surfaces edge failures (write fails: %s, #1281)", async (writeFails) => {
    const actual = await vi.importActual<typeof import("@repo/platform/engine/lib/routing-domains")>(
      "@repo/platform/engine/lib/routing-domains",
    );
    const domain = {
      id: "custom-domain", projectId: "project-1", hostname: "app.example.com",
      domainType: "custom", serviceId: null, targetPort: null, targetPath: null,
      verified: false, sslStatus: "none",
    };
    mocks.prepareImage.mockImplementationOnce(async () => {
      // Verification finishes while the image is being prepared, before routing
      // reads the fresh domain rows. No active deployment exists to reapply yet.
      domain.verified = true;
      domain.sslStatus = "active";
      return { status: "deploying", imageRef: RESOLVED_IMAGE, durationMs: 12 };
    });
    vi.mocked(repos.domain.listByProject).mockResolvedValueOnce([domain] as never);
    vi.mocked(buildProjectRouteDomains).mockImplementationOnce(actual.buildProjectRouteDomains);
    vi.mocked(toRoutedDomainInputs).mockImplementationOnce(actual.toRoutedDomainInputs);
    vi.mocked(ensureRouteDomainRecord).mockResolvedValueOnce({ domain, created: false } as never);
    const registerRoute = vi.fn().mockResolvedValue(undefined);
    if (writeFails) registerRoute.mockRejectedValue(new Error("Edge reload failed"));
    vi.mocked(resolveDeploymentPlatform).mockResolvedValue({
      ...resolvedPlatform,
      platform: { ...resolvedPlatform.platform, routing: { registerRoute } as never },
    });
    mocks.runDeployPipeline.mockImplementationOnce(runRealDeployPipeline);

    await run();
    await drainDeploymentExecutions();

    expect(registerRoute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      domain: "app.example.com", targetUrl: "http://172.18.0.2:8080", tls: true,
    }));
    expect(mocks.onSuccess).toHaveBeenCalledOnce();
    const meta = mocks.onSuccess.mock.calls[0]![1].metaPatch ?? {};
    if (writeFails) {
      expect(meta).toMatchObject({ edgeUnsynced: true, deployWarning: "routing warning" });
    } else {
      expect(meta).not.toHaveProperty("edgeUnsynced");
    }
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

  it.each(["docker", "kubernetes", "swarm"].flatMap(runtimeName =>
    ["update", "manual", "redeploy"].map(trigger => ({ runtimeName, trigger })),
  ))("$runtimeName $trigger refreshes the registry image, skips source builds, and freezes the digest", async ({ runtimeName, trigger }) => {
    resolvedRuntime.name = runtimeName;
    await run(deployment({ trigger }));
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
        forcePull: trigger === "update",
        refreshMutableTag: trigger !== "update",
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

  describe("Cloud queue release hook smoke", () => {
    const reservation = { cpuCores: 1, memoryMb: 1024, diskMb: 0 };
    const source = () => deployment({ meta: {
      ...snapshot(), source: "git", build: "dockerfile", releaseImageRef: undefined,
    } });
    async function withCloud(work: () => Promise<void>) {
      const old = env.CLOUD_MODE;
      Object.assign(env, { CLOUD_MODE: true });
      try { await work(); }
      finally {
        await waitForDeploymentQuiescence("deployment-1", "project-1");
        if (mocks.deferUnactivatedCloudBuild.mock.calls.length) await drainDeploymentExecutions();
        else await vi.waitFor(() => expect(mocks.cancelReservation).toHaveBeenCalled());
        Object.assign(env, { CLOUD_MODE: old });
      }
    }

    const admissionDeferred = (reason: ConstructorParameters<typeof CloudBuildAdmissionDeferredError>[0] = "CLOUD_WORKSPACE_ACTIVITY_BUSY") =>
      new CloudBuildAdmissionDeferredError(reason, new AppError("Waiting for server capacity", 409, reason));

    it.each(["CLOUD_WORKSPACE_ACTIVITY_BUSY", "CLOUD_WORKSPACE_BUSY", "CLOUD_BUILD_PROJECT_BUSY", "CLOUD_BUILD_HOST_NOT_READY", "CLOUD_WORKSPACE_BUILD_CAPACITY"] as const)(
      "returns %s to queued without failure, completion, or an immediate retry", async reason => withCloud(async () => {
        mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, []));
        mocks.activityGate.mockRejectedValueOnce(admissionDeferred(reason));
        mocks.deferUnactivatedCloudBuild.mockResolvedValueOnce(true);
        await run(source(), { workspaceId: "workspace-1" });
        await vi.waitFor(() => expect(mocks.sessionUpdateStatus).toHaveBeenCalledWith("deployment-1", "queued"));
        await drainDeploymentExecutions();
        expect(mocks.deferUnactivatedCloudBuild).toHaveBeenCalledExactlyOnceWith({
          deploymentId: "deployment-1", buildSessionId: "build-session-1", projectId: "project-1",
          organizationId: "org-1", workspaceId: "workspace-1",
        });
        expect(requestDeploymentCancellation("deployment-1")).toBe(false);
        expect(mocks.acknowledgeBuildExecutionFinished).not.toHaveBeenCalled();
        expect(mocks.cancelReservation).not.toHaveBeenCalled();
        expect(mocks.reconcileRetention).not.toHaveBeenCalled();
        expect(mocks.drainQueue).not.toHaveBeenCalled();
        expect(mocks.build).not.toHaveBeenCalled();
        expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
        expect(mocks.reportPipelineError).not.toHaveBeenCalled();
      }),
    );

    it("resumes a deferred build with fresh cancellation ownership and its existing SSE session", async () => withCloud(async () => {
      const writer = vi.fn();
      const savedSession = { subscribers: new Set([writer]), logs: [{ seq: 7, message: "backup finished" }], nextSeq: 8 };
      mocks.getSession.mockReturnValueOnce(undefined).mockReturnValue(savedSession);
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, []));
      mocks.activityGate.mockRejectedValueOnce(admissionDeferred());
      mocks.deferUnactivatedCloudBuild.mockResolvedValueOnce(true);
      const dep = await run(source(), { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.sessionUpdateStatus).toHaveBeenCalledWith("deployment-1", "queued"));
      await drainDeploymentExecutions();
      const firstSignal = vi.mocked(firePreDeployBackups).mock.calls[0]![0].signal;
      expect(requestDeploymentCancellation("deployment-1")).toBe(false);
      expect(mocks.drainQueue).not.toHaveBeenCalled();
      mocks.build.mockResolvedValueOnce({ sessionId: "build-session-1", status: "deploying", imageRef: "resumed-image", durationMs: 12 });
      await run(dep, { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.reconcileRetention).toHaveBeenCalledOnce());
      const secondSignal = vi.mocked(firePreDeployBackups).mock.calls[1]![0].signal;
      expect(secondSignal).not.toBe(firstSignal);
      expect(secondSignal?.aborted).toBe(false);
      expect(mocks.createSession).toHaveBeenCalledOnce();
      expect(mocks.getSession).toHaveBeenCalledTimes(2);
      expect(mocks.sessionUpdateStatus).toHaveBeenCalledWith("deployment-1", "building");
      expect(savedSession).toEqual({ subscribers: new Set([writer]), logs: [{ seq: 7, message: "backup finished" }], nextSeq: 8 });
      expect(mocks.build).toHaveBeenCalledOnce();
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();
      expect(mocks.reportPipelineError).not.toHaveBeenCalled();
    }));

    it("does not register a newly claimed retry before the deferring worker unregisters", async () => withCloud(async () => {
      const dep = source();
      const durable: Deployment = { ...dep };
      mocks.findDeploymentById.mockImplementation(async () => ({ ...durable }));
      mocks.claimBuildExecution.mockImplementation(async () => { durable.status = "building"; return "claimed"; });
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, []));
      mocks.activityGate.mockRejectedValueOnce(admissionDeferred());
      mocks.deferUnactivatedCloudBuild.mockImplementationOnce(async () => {
        durable.status = "queued";
        // A new admission can claim the reset DB row before the old callback
        // returns. It must wait for exact ownership before registering locally.
        await runOutsideCloudBuildActivity(() => kickoffBuild(project({ workspaceId: "workspace-1" }), { ...durable }));
        expect(requestDeploymentCancellation("deployment-1")).toBe(true);
        return true;
      });
      mocks.build.mockResolvedValueOnce({ sessionId: "build-session-1", status: "deploying", imageRef: "resumed-image", durationMs: 12 });
      await kickoffBuild(project({ workspaceId: "workspace-1" }), dep);
      await vi.waitFor(() => expect(mocks.reconcileRetention).toHaveBeenCalledOnce());
      const signals = vi.mocked(firePreDeployBackups).mock.calls.map(([opts]) => opts.signal);
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]).not.toBe(signals[0]);
      expect(signals[1]?.aborted).toBe(false);
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();
      expect(mocks.build).toHaveBeenCalledOnce();
      expect(mocks.reportPipelineError).not.toHaveBeenCalled();
    }));

    it("acknowledges normally when cancellation wins the atomic deferral", async () => withCloud(async () => {
      const dep = source();
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, []));
      mocks.activityGate.mockRejectedValueOnce(admissionDeferred());
      mocks.deferUnactivatedCloudBuild.mockImplementationOnce(async () => { dep.status = "cancelled"; return false; });
      await run(dep, { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.reconcileRetention).toHaveBeenCalledOnce());
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();
      expect(mocks.cancelReservation).toHaveBeenCalledOnce();
      expect(mocks.sessionUpdateStatus).not.toHaveBeenCalledWith("deployment-1", "queued");
      expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    }));

    it.each(["build", "activity cleanup"])("never defers errors after %s has begun", async phase => withCloud(async () => {
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, []));
      if (phase === "build") mocks.build.mockRejectedValueOnce(admissionDeferred());
      else {
        mocks.build.mockResolvedValueOnce({ sessionId: "build-session-1", status: "deploying", imageRef: "built-image", durationMs: 12 });
        mocks.activityGate.mockImplementationOnce(async work => { await work(); throw admissionDeferred(); });
      }
      await run(source(), { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.reconcileRetention).toHaveBeenCalledOnce());
      expect(mocks.deferUnactivatedCloudBuild).not.toHaveBeenCalled();
      expect(mocks.build).toHaveBeenCalledOnce();
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();
    }));

    it("does not treat a backup error as a deferred activity claim", async () => withCloud(async () => {
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, []));
      vi.mocked(firePreDeployBackups).mockRejectedValueOnce(admissionDeferred());
      await run(source(), { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.reconcileRetention).toHaveBeenCalledOnce());
      expect(mocks.deferUnactivatedCloudBuild).not.toHaveBeenCalled();
      expect(mocks.activityGate).not.toHaveBeenCalled();
      expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();
    }));

    it.each([false, true])("keeps configured limits separate from the reservation and releases it after the build (configured: %s)", async configured => withCloud(async () => {
      let finishBuild!: () => void;
      let finishDeploy!: () => void;
      const building = new Promise<void>(resolve => { finishBuild = resolve; });
      const deploying = new Promise<void>(resolve => { finishDeploy = resolve; });
      const workerResources = configured
        ? { cpuCores: 0.5, memoryMb: 512, diskMb: 0 }
        : { cpuCores: 0, memoryMb: 0, diskMb: 0 };
      const row = source();
      Object.assign(row.meta!, { buildResources: configured ? workerResources : null });
      vi.mocked(resolveBuildResources).mockReturnValue(workerResources);
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation));
      mocks.build.mockImplementationOnce(async () => {
        await building;
        return { sessionId: "build-session-1", status: "deploying", imageRef: "built-image", durationMs: 12 };
      });
      mocks.deploy.mockImplementationOnce(async () => {
        await deploying;
        return { status: "success", containerId: "container-1", url: "http://172.18.0.2:8080" };
      });
      vi.mocked(releaseCloudBuildSlot).mockImplementationOnce(async () => {
        expect(cloudBuildActivityContext.getStore()?.identity.deploymentId).toBe("deployment-1");
      });
      const dispatchContexts: unknown[] = [];
      mocks.drainQueue.mockImplementation(async () => {
        dispatchContexts.push(cloudBuildActivityContext.getStore());
        return { started: 0 };
      });
      try {
        await run(row, { workspaceId: "workspace-1" });
        await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
        expect(mocks.claimBuildExecution).toHaveBeenCalledWith(expect.objectContaining({
          cloudBuildReservation: { workspaceId: "workspace-1", resources: reservation, exclusivePreparation: false },
        }));
        expect(mocks.build.mock.calls[0]?.[0].resources).toEqual(workerResources);
        expect(row.meta).toMatchObject({ buildResources: configured ? workerResources : null });
        expect(releaseCloudBuildSlot).not.toHaveBeenCalled();
        finishBuild();
        await vi.waitFor(() => expect(mocks.deploy).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(mocks.drainQueue).toHaveBeenCalledWith("workspace-1"));
        expect(releaseCloudBuildSlot).toHaveBeenCalledOnce();
        expect(dispatchContexts).toEqual([undefined]);
        expect(mocks.acknowledgeBuildExecutionFinished).not.toHaveBeenCalled();
      } finally {
        finishBuild(); finishDeploy();
        vi.mocked(resolveBuildResources).mockReturnValue({} as never);
      }
    }));

    it.each([false, true])("passes the captured backup policies through admission (backups: %s)", async hasBackups => withCloud(async () => {
      // This pipeline test checks forwarding; the trigger owns policy execution
      // and verifies that an explicitly empty capture does not reread policies.
      const policy = { id: "captured-policy", createdBy: "owner" };
      const policies = hasBackups ? [policy] : [];
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation, policies));
      mocks.build.mockResolvedValueOnce({ sessionId: "build-session-1", status: "deploying", imageRef: "built-image", durationMs: 12 });
      await run(source(), { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce());
      expect(mocks.claimBuildExecution).toHaveBeenCalledWith(expect.objectContaining({
        cloudBuildReservation: { workspaceId: "workspace-1", resources: reservation, exclusivePreparation: hasBackups },
      }));
      expect(firePreDeployBackups).toHaveBeenCalledOnce();
      expect(vi.mocked(firePreDeployBackups).mock.calls[0]?.[0].policies).toBe(policies);
      expect(mocks.build).toHaveBeenCalledOnce();
      expect(vi.mocked(firePreDeployBackups).mock.invocationCallOrder[0])
        .toBeLessThan(mocks.build.mock.invocationCallOrder[0]!);
    }));

    it("retries dispatch after a build failure only after worker acknowledgement", async () => withCloud(async () => {
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation));
      mocks.build.mockRejectedValueOnce(new Error("source build failed"));
      await run(source(), { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(mocks.drainQueue).toHaveBeenCalled());
      expect(releaseCloudBuildSlot).not.toHaveBeenCalled();
      expect(mocks.acknowledgeBuildExecutionFinished.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.drainQueue.mock.invocationCallOrder[0]!);
    }));

    it("an unavailable retained image must not start an unreserved source build", async () => withCloud(async () => {
      const pinned = source() as any;
      pinned.meta.handoverAppImage = "missing-retained-image";
      // Simulate missing admission resources: the queue now reserves potential
      // handover fallback builds, and the pipeline must reject an unreserved one.
      await run(pinned, { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce());
      expect(mocks.claimBuildExecution).toHaveBeenCalledWith(expect.objectContaining({
        cloudBuildReservation: { workspaceId: "workspace-1", resources: null, exclusivePreparation: false },
      }));
      expect(mocks.build).not.toHaveBeenCalled();
    }));

    it("slot-release failure must still clean up the image just built", async () => withCloud(async () => {
      mocks.admitQueue.mockImplementation(async (_project, _dep, start) => start(reservation));
      mocks.build.mockResolvedValueOnce({ sessionId: "build-session-1", status: "deploying", imageRef: "built-before-release-error", durationMs: 12 });
      vi.mocked(releaseCloudBuildSlot).mockRejectedValueOnce(new Error("release write failed"));
      await run(source(), { workspaceId: "workspace-1" });
      await vi.waitFor(() => expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce());
      expect(mocks.deploy).not.toHaveBeenCalled();
      expect(mocks.reportPipelineError).toHaveBeenCalledOnce();
      expect(mocks.reportPipelineError.mock.calls[0]?.[0].provisioned.imageRef).toBe("built-before-release-error");
    }));
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

  it("does not run release commands or activation when cancellation wins the release transition", async () => {
    mocks.setDeploymentStatus.mockImplementation(async (_id, status) => status !== "deploying");
    await run(deployment({ meta: { ...snapshot(), releaseCommands: ["migrate"] } }));
    await vi.waitFor(() => expect(mocks.onCancelled).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.runReleaseCommand).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.reportPipelineError).not.toHaveBeenCalled();
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
      expect.anything(),
      "Project release commands are not supported on multi-service deployments. " +
        "Deployment stopped before activation. " +
        "To keep the release commands, deploy the app as a new single-app Docker project. " +
        "Connect separately deployed services through Apps & Services → Add → Connect existing. " +
        "Connecting services does not convert this project back to single-app. " +
        "Otherwise remove the release commands.",
      expect.anything(), undefined,
    );
    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    expect(executeComposePipeline).not.toHaveBeenCalled();
    expect(mocks.runReleaseCommand).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it.each([
    ["a rollback", { trigger: "rollback" }, {}],
    ["a service-only action", { trigger: "redeploy" }, { targetServiceIds: ["svc-db"] }],
  ])("deploys %s of a multi-service project without refusing its release commands", async (_label, dep, meta) => {
    vi.mocked(shouldUseProjectServicePipeline).mockResolvedValue(true);
    vi.mocked(isMultiServiceRuntime).mockReturnValue(true);
    await run(deployment({ ...dep, meta: {
      ...snapshot(), serviceDeploymentMode: "services", releaseCommands: ["migrate"], ...meta,
      composeServices: [{ name: "db", image: "postgres:16", ports: [], dependsOn: [], environment: {}, volumes: [] }],
    } }));
    await drainDeploymentExecutions();
    expect(executeComposePipeline).toHaveBeenCalledOnce();
    expect(mocks.reportPipelineError).not.toHaveBeenCalled();
    expect(mocks.runReleaseCommand).not.toHaveBeenCalled();
  });

  it("refuses runtime roles on a multi-service deployment before the build starts", async () => {
    vi.mocked(shouldUseProjectServicePipeline).mockResolvedValue(true);
    vi.mocked(isMultiServiceRuntime).mockReturnValue(true);
    await run(deployment({ meta: {
      ...snapshot(), serviceDeploymentMode: "services",
      roles: [{ name: "queue", kind: "worker", command: "php artisan queue:work" }],
      composeServices: [{ name: "redis", image: "redis:7", ports: [], dependsOn: [], environment: {}, volumes: [] }],
    } }));
    await vi.waitFor(() => expect(mocks.reportPipelineError).toHaveBeenCalledOnce());
    await waitForDeploymentQuiescence("deployment-1", "project-1");
    expect(mocks.reportPipelineError).toHaveBeenCalledWith(
      expect.anything(), expect.stringMatching(/^Runtime roles are not supported on multi-service deployments yet\. /), expect.anything(), undefined,
    );
    expect(mocks.setDeploymentStatus).not.toHaveBeenCalledWith("deployment-1", "building");
    expect(executeComposePipeline).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it.each([[true, true], [true, false], [false, true], [false, false]])("source services preserve saved build limits (Cloud: %s, configured: %s)", async (cloudMode, configured) => {
    const originalCloudMode = env.CLOUD_MODE;
    Object.assign(env, { CLOUD_MODE: cloudMode });
    const resources = configured
      ? { cpuCores: 0.5, memoryMb: 512, diskMb: 8192 }
      : { cpuCores: 0, memoryMb: 0, diskMb: 0 };
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
        buildResources: configured ? resources : null,
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
        expect(mocks.sampleCloudWorkspaceResources).toHaveBeenCalledExactlyOnceWith("org-1", "workspace-1", configured);
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

  it.each([false, true])("inventories loopback claims with routed=%s, preparing edge only for routes", async (routed) => {
    vi.mocked(buildProjectRouteDomains).mockReturnValueOnce(routed ? [{
      hostname: "app.example.com", tls: false, provisionSsl: false,
      requiresSslTooling: false, terminatesTlsLocally: false, isCloud: false,
      targetPort: 8080,
    }] : []);
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

    expect(mocks.ensureRoutingReady).toHaveBeenCalledTimes(routed ? 1 : 0);
    expect(ensureEdgeChallengeReady).toHaveBeenCalledTimes(routed ? 1 : 0);
    expect(repairEdgeVhosts).toHaveBeenCalledTimes(routed ? 1 : 0);
    expect(mocks.prepareTargetPinnedHostPorts).toHaveBeenCalledTimes(1);
    expect(mocks.allocateAndReservePinnedHostPort).toHaveBeenCalledTimes(1);
    if (routed) {
      expect(mocks.ensureRoutingReady.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.prepareTargetPinnedHostPorts.mock.invocationCallOrder[0]!,
      );
    }
    expect(mocks.prepareTargetPinnedHostPorts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.allocateAndReservePinnedHostPort.mock.invocationCallOrder[0]!,
    );
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ hostPort: 30_000 }),
      expect.any(Function),
    );
    expect(ensurePortAvailable).toHaveBeenCalledExactlyOnceWith(
      resolvedPlatform.platform.executor, 30_000, expect.anything(), expect.any(Function),
      expect.objectContaining({ suggestAlternative: expect.any(Function) }),
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
    [
      "an invalid PROXY protocol setting",
      true,
      new EdgeProxyProtocolConfigError(
        "Edge configuration was not changed: OPENSHIP_EDGE_PROXY_PROTOCOL=https requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED",
      ),
    ],
    [
      "a half-restored earlier change",
      true,
      new EdgeConfigRecoveryError("reload refused; rollback failed: a.conf: read-only file system"),
    ],
    [
      "an invalid setting, on a target without a system manager",
      false,
      new EdgeProxyProtocolConfigError(
        "Edge configuration was not changed: OPENSHIP_EDGE_PROXY_PROTOCOL=https requires OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED",
      ),
    ],
  ])(
    "stops before activation when the edge refuses every route change: %s",
    async (_, withSystem, refusal) => {
      if (!withSystem) {
        vi.mocked(resolveDeploymentPlatform).mockResolvedValue({
          ...resolvedPlatform,
          platform: { ...resolvedPlatform.platform, system: null },
        });
      }
      vi.mocked(buildProjectRouteDomains).mockReturnValueOnce([
        {
          hostname: "app.example.com",
          tls: true,
          provisionSsl: false,
          requiresSslTooling: false,
          terminatesTlsLocally: true,
          isCloud: false,
          targetPort: 8080,
        },
      ]);
      vi.mocked(repairEdgeVhosts).mockRejectedValueOnce(refusal);
      let preflight: unknown;
      mocks.runDeployPipeline.mockImplementationOnce(async (env, input) => {
        preflight = await env
          .preflight(input.config, async () => "migrate")
          .catch((err: unknown) => err);
        if (preflight instanceof Error) throw preflight;
        await env.activate(input.config, () => undefined);
        return { status: "success" };
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await run(deployment(), { routeStrategy: "loopback-port" });
        await drainDeploymentExecutions();
      } finally {
        log.mockRestore();
      }

      expect(preflight).toBe(refusal);
      expect(repairEdgeVhosts).toHaveBeenCalledOnce();
      // The previous release keeps its route and its port: nothing was activated.
      expect(mocks.prepareTargetPinnedHostPorts).not.toHaveBeenCalled();
      expect(mocks.deploy).not.toHaveBeenCalled();
      expect(mocks.onSuccess).not.toHaveBeenCalled();
    },
  );

  it("saves the selected host port for activation, routing and future redeploys", async () => {
    mocks.suggestAlternativePinnedHostPort.mockImplementation(async (input) => ({
      port: 20002,
      apply: async () => {
        input.onSelected({
          ...input.allocation,
          port: 20002,
          claimWasCreated: true,
          claim: { ...input.allocation.claim, port: 20002 },
        });
        return true;
      },
    }));
    vi.mocked(ensurePortAvailable).mockImplementationOnce(
      async (_executor, _port, _logger, _prompt, options) => {
        const alternative = await options!.suggestAlternative!(new Set([30000]));
        expect(mocks.deploy).not.toHaveBeenCalled();
        expect(repos.project.update).not.toHaveBeenCalled();
        expect(await alternative!.apply()).toBe(true);
      },
    );
    mocks.getContainerInfo.mockResolvedValue({ ipAddress: "172.18.0.2", hostPort: 20002 });
    mocks.runDeployPipeline.mockImplementationOnce(async (environment, input) => {
      await environment.preflight(input.config, async () => "use_port:20002");
      const result = await environment.activate(input.config, () => undefined);
      const url = await environment.resolveTargetUrl(result.containerId, input.config.port);
      return { status: "success", containerId: result.containerId, url };
    });

    await run(deployment(), { routeStrategy: "loopback-port", hostPort: 30000 });
    await drainDeploymentExecutions();

    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8080, hostPort: 20002 }),
      expect.any(Function),
    );
    expect(repos.project.update).toHaveBeenCalledWith("project-1", { hostPort: 20002 });
    expect(mocks.reserveVerifiedTargetPinnedHostPort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ port: 20002, containerPort: 8080 }),
      expect.any(Function),
    );
    expect(mocks.convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredPublishes: [{ serviceId: null, containerPort: 8080, hostPort: 20002 }],
      }),
    );
    expect(mocks.onSuccess).toHaveBeenCalledOnce();
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

  it("keeps a successful deploy ready and surfaces a previous role container it could not remove", async () => {
    // The new release declares no roles, so the rollout only retires the old one on commit.
    const previous = deployment({
      id: "previous-deployment",
      containerId: "old-container",
      status: "ready",
      roleContainers: [{ role: "queue", replica: 1, containerId: "old-queue-01" }],
    });
    const next = deployment();
    mocks.findDeploymentById.mockImplementation(async (id) =>
      id === "previous-deployment" ? previous : next,
    );
    vi.mocked(resolveDeploymentRuntime).mockResolvedValue({ runtime: resolvedRuntime } as never);
    mocks.destroy.mockImplementation(async (id) => {
      if (id === "old-queue-01") throw new Error("Docker removal failed");
    });

    await kickoffBuild(project({ activeDeploymentId: "previous-deployment" }), next);
    await drainDeploymentExecutions();

    expect(mocks.destroy).toHaveBeenCalledWith("old-queue-01");
    expect(mocks.onFailure).not.toHaveBeenCalled();
    expect(mocks.onSuccess).toHaveBeenCalledOnce();
    const result = mocks.onSuccess.mock.calls[0]![1] as {
      warningMessage?: string;
      metaPatch?: Record<string, unknown>;
    };
    expect(result.warningMessage).toBe(
      "Previous role container queue replica 1 (old-queue-01) could not be removed. " +
        "It may still be running the previous release's code. Remove it manually.",
    );
    // Not a routing problem: no "Retry routing" signal.
    expect(result.metaPatch?.deployWarning).toBeUndefined();
    expect(result.metaPatch?.edgeUnsynced).toBeUndefined();
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
