import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertGitHubRepoAccess,
  getForwardGitToServer,
  kickoffBuild,
  repos,
  resolveProjectRouteState,
  resolveServicePipelineMode,
  resolveSmartRoute,
  resolveStrategy,
  runPreflightChecks,
  syncProjectRouteState,
} = vi.hoisted(() => ({
  assertGitHubRepoAccess: vi.fn(),
  getForwardGitToServer: vi.fn(),
  kickoffBuild: vi.fn(),
  repos: {
    project: {
      findById: vi.fn(),
      getEnvMap: vi.fn(),
      update: vi.fn(),
    },
    deployment: {
      findById: vi.fn(),
      listByProject: vi.fn(),
      getLatestSuccessfulForBranch: vi.fn(),
      create: vi.fn(),
      createBuildSession: vi.fn(),
      supersedeReconciling: vi.fn(),
      supersedePendingDecisions: vi.fn(),
    },
    service: {
      listByProject: vi.fn(),
      syncFromCompose: vi.fn(),
    },
  },
  resolveProjectRouteState: vi.fn(),
  resolveServicePipelineMode: vi.fn(),
  resolveSmartRoute: vi.fn(),
  resolveStrategy: vi.fn(),
  runPreflightChecks: vi.fn(),
  syncProjectRouteState: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos,
}));

vi.mock("../../../src/modules/deployments/preflight", () => ({
  runPreflightChecks,
}));

vi.mock("../../../src/modules/deployments/build-pipeline", () => ({
  kickoffBuild,
  resolveServicePipelineMode,
}));

vi.mock("../../../src/modules/domains/project-route.service", () => ({
  listProjectRouteRows: vi.fn(),
  resolveProjectRouteState,
  syncProjectRouteState,
}));

vi.mock("../../../src/modules/github/github-access", () => ({
  assertGitHubRepoAccess,
}));

vi.mock("../../../src/modules/github/github.service", () => ({
  getLatestCommit: vi.fn(),
  getRepository: vi.fn(),
}));

vi.mock("../../../src/modules/settings/settings.service", () => ({
  resolveStrategy,
  getForwardGitToServer,
}));

vi.mock("../../../src/modules/deployments/smart-route", () => ({
  resolveSmartRoute,
}));

import {
  requestBuildAccess,
  resolveSnapshotTarget,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "../../../src/modules/deployments/build.service";
import {
  newFolderSessionId,
  putFolderSession,
} from "../../../src/modules/projects/folder/session-store";

const ctx = { userId: "user-1", organizationId: "org-1" } as any;

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    organizationId: "org-1",
    appTemplateId: null,
    activeDeploymentId: null,
    gitUrl: null,
    localPath: "/srv/my-stack",
    gitProvider: "local",
    gitOwner: null,
    gitRepo: null,
    gitBranch: "main",
    slug: "my-stack",
    framework: "docker-compose",
    packageManager: "npm",
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    productionPaths: null,
    rootDirectory: null,
    startCommand: null,
    buildImage: null,
    productionMode: "host",
    port: 3000,
    hasServer: true,
    hasBuild: true,
    resources: null,
    buildResources: null,
    cloudWorkspaceId: null,
    runtimeMode: "docker",
    defaultRollbackStrategy: "git",
    ...overrides,
  };
}

const composeServices = [
  {
    id: "svc-web",
    kind: "compose",
    enabled: true,
    name: "web",
    image: undefined,
    build: ".",
    dockerfile: "Dockerfile",
    ports: ["3000:3000"],
    dependsOn: [],
    environment: {},
    volumes: [],
    exposed: true,
    exposedPort: "3000",
    domainType: "free",
  },
];

function baseSnapshot(): DeploymentConfigSnapshot {
  return {
    organizationId: "org-1",
    repoUrl: "",
    branch: "main",
    framework: "docker-compose",
    buildImage: null as unknown as string,
    runtimeImage: "docker:latest",
    packageManager: "npm",
    installCommand: null as unknown as string,
    buildCommand: null as unknown as string,
    outputDirectory: null as unknown as string,
    productionPaths: [],
    rootDirectory: "",
    port: 3000,
    startCommand: null as unknown as string,
    resources: null,
    buildResources: null,
    hasServer: true,
    hasBuild: true,
    localPath: "/srv/my-stack",
    deployTarget: "server",
    runtimeMode: "docker",
    composeServices: composeServices as any,
  };
}

/**
 * The single place that decides a snapshot's target. The durable `project.serverId`
 * (Fix 2a) is what stops a server-hosted project from regressing to "local" on a
 * fresh/partial snapshot — the root of the Access-URL-shows-localhost bug — so the
 * priority order here is load-bearing, not cosmetic.
 */
describe("resolveSnapshotTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function project(overrides: Record<string, unknown> = {}) {
    return {
      id: "project-1",
      activeDeploymentId: null,
      cloudWorkspaceId: null,
      serverId: null,
      runtimeMode: null,
      ...overrides,
    } as any;
  }

  it("uses the durable project.serverId even when there is no active deployment", async () => {
    const t = await resolveSnapshotTarget(project({ serverId: "srv_1" }));
    expect(t).toMatchObject({ deployTarget: "server", serverId: "srv_1" });
    expect(repos.deployment.findById).not.toHaveBeenCalled();
  });

  // The regression itself: the last deploy mis-resolved and stamped "local", but the
  // project is durably bound to a server, so the NEXT deploy must stay on the server
  // rather than inherit the bad "local" from active meta.
  it("keeps a server-bound project on the server even when active meta says local", async () => {
    repos.deployment.findById.mockResolvedValue({
      meta: { deployTarget: "local" } as DeploymentConfigSnapshot,
    });
    const t = await resolveSnapshotTarget(
      project({ activeDeploymentId: "dep_old", serverId: "srv_1" }),
    );
    expect(t).toMatchObject({ deployTarget: "server", serverId: "srv_1" });
  });

  it("lets cloud win over a stray serverId and drops the serverId", async () => {
    const t = await resolveSnapshotTarget(
      project({ cloudWorkspaceId: "ws_1", serverId: "srv_1" }),
    );
    expect(t.deployTarget).toBe("cloud");
    expect(t.serverId).toBeUndefined();
  });

  it("lets an explicit override win over the durable binding", async () => {
    const t = await resolveSnapshotTarget(
      project({ serverId: "srv_1" }),
      { deployTarget: "server", serverId: "srv_override" },
    );
    expect(t).toMatchObject({ deployTarget: "server", serverId: "srv_override" });
  });

  // Legacy rows not yet backfilled with project.serverId still resolve via the
  // active deployment's stamped meta — step 5 in the precedence.
  it("infers server from legacy active-meta serverId when the column is empty", async () => {
    repos.deployment.findById.mockResolvedValue({
      meta: { serverId: "srv_legacy" } as DeploymentConfigSnapshot,
    });
    const t = await resolveSnapshotTarget(
      project({ activeDeploymentId: "dep_old", serverId: null }),
    );
    expect(t).toMatchObject({ deployTarget: "server", serverId: "srv_legacy" });
  });

  it("resolves to local (undefined target, no serverId) with no cloud, no server, no meta", async () => {
    const t = await resolveSnapshotTarget(project());
    expect(t.deployTarget).toBeUndefined();
    expect(t.serverId).toBeUndefined();
  });
});

describe("triggerDeployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    repos.project.findById.mockResolvedValue(baseProject());
    repos.project.getEnvMap.mockResolvedValue({});
    repos.deployment.listByProject.mockResolvedValue({ rows: [] });
    repos.deployment.getLatestSuccessfulForBranch.mockResolvedValue(null);
    repos.deployment.create.mockResolvedValue({ id: "dep-1", projectId: "project-1" });
    repos.deployment.createBuildSession.mockResolvedValue(undefined);
    repos.deployment.supersedeReconciling.mockResolvedValue(undefined);
    repos.deployment.supersedePendingDecisions.mockResolvedValue(undefined);

    assertGitHubRepoAccess.mockResolvedValue(undefined);
    resolveProjectRouteState.mockResolvedValue({
      primaryCustomDomain: undefined,
      primaryDomainType: undefined,
      primarySlug: undefined,
      publicEndpoints: [],
    });
    resolveServicePipelineMode.mockResolvedValue({
      useServicePipeline: true,
      servicePreflightServices: composeServices,
      useSingleAppPipeline: false,
    });
    resolveStrategy.mockResolvedValue("local");
    resolveSmartRoute.mockResolvedValue({
      forceAll: undefined,
      serviceIds: undefined,
      changedPaths: undefined,
    });
    runPreflightChecks.mockResolvedValue({ ok: true, checks: [] });
    kickoffBuild.mockResolvedValue("session-1");
  });

  it("passes compose service mode into preflight for manual services deploys", async () => {
    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "abc123",
    });

    expect(resolveServicePipelineMode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({ framework: "docker-compose" }),
    );
    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        multiService: true,
        composeServices,
      }),
    );
  });

  it("resolves service mode before preflight for reused snapshots", async () => {
    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "abc123",
      reuseSnapshot: {
        meta: baseSnapshot(),
        envVars: null,
      },
    });

    expect(resolveServicePipelineMode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({ composeServices }),
    );
    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        multiService: true,
        composeServices,
      }),
    );
  });
});

/**
 * Folder-upload deploys (#334): the scan parses the uploaded compose file, but
 * the documented session → scan → ensure → deploy flow has no step that hands
 * those services back — so the deploy must take them off the upload session or
 * the project deploys with zero service rows.
 */
describe("requestBuildAccess — folder-upload compose services", () => {
  /** The scan's parsed compose, as stored on the session. */
  const scannedServices = [
    {
      name: "api",
      image: "ghcr.io/acme/api:1",
      ports: ["8080:8080"],
      dependsOn: [],
      environment: {},
      volumes: [],
    },
  ];

  /** Seed a self-hosted (relay) upload session that has already been scanned. */
  function seedSession(overrides: Record<string, unknown> = {}): string {
    const id = newFolderSessionId();
    putFolderSession({
      id,
      orgId: "org-1",
      userId: "user-1",
      mode: "api-relay",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      stagingDir: "/tmp/openship-upload-x",
      uploadTicket: "ticket",
      uploaded: true,
      services: scannedServices as any,
      ...overrides,
    } as any);
    return id;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // An uploaded folder: no git source, framework detected as docker-compose.
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "upload", localPath: null, runtimeMode: null }),
    );
    repos.project.getEnvMap.mockResolvedValue({});
    repos.deployment.findById.mockResolvedValue(null);
    repos.deployment.listByProject.mockResolvedValue({ rows: [] });
    repos.deployment.getLatestSuccessfulForBranch.mockResolvedValue(null);
    repos.deployment.create.mockResolvedValue({ id: "dep-1", projectId: "project-1" });
    repos.deployment.createBuildSession.mockResolvedValue(undefined);
    repos.deployment.supersedeReconciling.mockResolvedValue(undefined);
    repos.deployment.supersedePendingDecisions.mockResolvedValue(undefined);
    // No service rows yet — the state right after projects/ensure created it.
    repos.service.listByProject.mockResolvedValue([]);
    repos.service.syncFromCompose.mockResolvedValue([]);

    assertGitHubRepoAccess.mockResolvedValue(undefined);
    getForwardGitToServer.mockResolvedValue(false);
    const emptyRouteState = {
      primaryCustomDomain: undefined,
      primaryDomainType: undefined,
      primarySlug: undefined,
      publicEndpoints: [],
    };
    resolveProjectRouteState.mockResolvedValue(emptyRouteState);
    // Only reached on the non-services paths (which default a project domain).
    syncProjectRouteState.mockResolvedValue(emptyRouteState);
    resolveServicePipelineMode.mockResolvedValue({
      useServicePipeline: true,
      servicePreflightServices: scannedServices,
      useSingleAppPipeline: false,
    });
    resolveStrategy.mockResolvedValue("server");
    runPreflightChecks.mockResolvedValue({ ok: true, checks: [] });
    kickoffBuild.mockResolvedValue("session-1");
  });

  it("adopts the session's scanned services when the caller sent none", async () => {
    const uploadSessionId = seedSession();

    const result = await requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId });

    expect(result.deployment_id).toBe("dep-1");
    // Persisted as real service rows...
    expect(repos.service.syncFromCompose).toHaveBeenCalledWith("project-1", scannedServices, {
      removeMissing: false,
    });
    // ...and carried in the snapshot, in services mode.
    expect(resolveServicePipelineMode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({
        serviceDeploymentMode: "services",
        composeServices: scannedServices,
      }),
    );
  });

  it("prefers the caller's services over the session's", async () => {
    const uploadSessionId = seedSession();
    const requested = [
      { name: "web", image: "nginx", ports: [], dependsOn: [], environment: {}, volumes: [] },
    ];

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      services: requested as any,
    });

    expect(repos.service.syncFromCompose).toHaveBeenCalledWith("project-1", requested, {
      removeMissing: false,
    });
  });

  // #336: the wizard sees env masked, so a deploy request can echo "••••••••".
  // The real value must be recovered (from the pre-mask session scan / stored
  // rows) before persistence — else the container launches with KEY=••••••••.
  it("#336: recovers the real env when the caller echoes the mask sentinel", async () => {
    const uploadSessionId = seedSession({
      services: [
        { name: "api", image: "ghcr.io/acme/api:1", ports: [], dependsOn: [], environment: { API_TOKEN: "real-token" }, volumes: [] },
      ],
    });
    const requested = [
      { name: "api", image: "ghcr.io/acme/api:1", ports: [], dependsOn: [], environment: { API_TOKEN: "••••••••" }, volumes: [] },
    ];

    await requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId, services: requested as any });

    expect(repos.service.syncFromCompose).toHaveBeenCalledWith(
      "project-1",
      [expect.objectContaining({ name: "api", environment: { API_TOKEN: "real-token" } })],
      { removeMissing: false },
    );
  });

  it("#336: drops a masked value with no recovery source (never persists the sentinel)", async () => {
    const uploadSessionId = seedSession({ services: [] });
    repos.service.listByProject.mockResolvedValue([]);
    const requested = [
      { name: "api", image: "x", ports: [], dependsOn: [], environment: { GHOST: "••••••••", REAL: "keep" }, volumes: [] },
    ];

    await requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId, services: requested as any });

    expect(repos.service.syncFromCompose).toHaveBeenCalledWith(
      "project-1",
      [expect.objectContaining({ name: "api", environment: { REAL: "keep" } })],
      { removeMissing: false },
    );
  });

  it("leaves an existing services project's own rows alone", async () => {
    const uploadSessionId = seedSession();
    repos.service.listByProject.mockResolvedValue([
      { id: "svc-1", name: "api", kind: "compose", enabled: true },
    ]);

    await requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId });

    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    // …and a redeploy of a service-first project must NOT default a
    // project-level free domain (services expose per service).
    expect(syncProjectRouteState).not.toHaveBeenCalled();
  });

  it("still defaults a project domain for a single-app upload", async () => {
    const uploadSessionId = seedSession({ services: undefined });
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "upload", localPath: null, framework: "nextjs" }),
    );

    await requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId });

    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    expect(syncProjectRouteState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({
        nextPublicEndpoints: [expect.objectContaining({ domain: "my-stack", domainType: "free" })],
      }),
    );
  });

  it("respects an explicit single-app deploy", async () => {
    const uploadSessionId = seedSession();

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      serviceDeploymentMode: "single",
    });

    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    expect(resolveServicePipelineMode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({ serviceDeploymentMode: "single" }),
    );
  });

  it("rejects an unknown or expired upload session", async () => {
    await expect(
      requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId: "nope" }),
    ).rejects.toThrow(/Upload session not found/);
  });

  it("rejects an upload session belonging to another org", async () => {
    const uploadSessionId = seedSession({ orgId: "org-other" });

    await expect(
      requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId }),
    ).rejects.toThrow(/Upload session not found/);
  });
});
