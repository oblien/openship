import { createConfigurationSecrets } from "@repo/db/configuration-secrets";
import { createEncryption } from "@repo/db/encryption";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  assertGitHubRepoAccess,
  getForwardGitToServer,
  getLatestCommit,
  requireClusterDeploymentTarget,
  kickoffBuild,
  repos,
  resolveProjectInfo,
  resolveProjectSourceEnv,
  resolveFolderSessionSourceEnv,
  scanFolderSession,
  resolveProjectRouteState,
  resolveServicePipelineMode,
  resolveSmartRoute,
  resolveStrategy,
  runPreflightChecks,
  syncProjectRouteState,
} = vi.hoisted(() => ({
  assertGitHubRepoAccess: vi.fn(),
  getForwardGitToServer: vi.fn(),
  getLatestCommit: vi.fn(),
  requireClusterDeploymentTarget: vi.fn(),
  kickoffBuild: vi.fn(),
  repos: {
    projectConnection: { listByTarget: vi.fn(async () => []) },
    project: {
      findById: vi.fn(),
      getEnvMap: vi.fn(),
      listEnvVars: vi.fn(),
      bulkSetEnvVars: vi.fn(),
      mergeEnvVars: vi.fn(),
      listEnvVarChangeMeta: vi.fn(),
      update: vi.fn(),
    },
    deployment: {
      findById: vi.fn(),
      findInProgressByCommit: vi.fn(),
      listInFlightByProject: vi.fn(),
      listByProject: vi.fn(),
      getLatestSuccessfulForBranch: vi.fn(),
      create: vi.fn(),
      createBuildSession: vi.fn(),
      supersedeReconciling: vi.fn(),
      supersedePendingDecisions: vi.fn(),
    },
    service: {
      listByProject: vi.fn(),
      reconcileFromCompose: vi.fn(),
      syncFromCompose: vi.fn(),
    },
    serviceDeployment: {
      latestByProject: vi.fn(),
    },
    updateStatus: {
      upsert: vi.fn(async () => {}),
    },
    server: {
      getInOrganization: vi.fn(),
    },
  },
  resolveProjectInfo: vi.fn(),
  resolveProjectSourceEnv: vi.fn(),
  resolveFolderSessionSourceEnv: vi.fn(),
  scanFolderSession: vi.fn(),
  resolveProjectRouteState: vi.fn(),
  resolveServicePipelineMode: vi.fn(),
  resolveSmartRoute: vi.fn(),
  resolveStrategy: vi.fn(),
  runPreflightChecks: vi.fn(),
  syncProjectRouteState: vi.fn(),
}));

// Partial, not a replacement: the graph reaches `lib/auth`, which reads `schema` and
// `getDriver()` at module scope. Only `repos` is under test.
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repos,
}));

vi.mock("@repo/platform/engine/modules/deployments/preflight", () => ({
  runPreflightChecks,
}));

vi.mock("@repo/platform/engine/lib/cluster-deployment-target", () => ({ requireClusterDeploymentTarget }));

vi.mock("@repo/platform/engine/modules/deployments/prepare.service", () => ({
  resolveProjectInfo,
  resolveProjectSourceEnv,
}));

vi.mock("@repo/platform/engine/modules/projects/folder/folder.service", () => ({
  scanFolderSession,
  resolveFolderSessionSourceEnv,
}));

vi.mock("@repo/platform/engine/modules/deployments/build-pipeline", () => ({
  kickoffBuild,
  resolveServicePipelineMode,
}));

vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  listProjectRouteRows: vi.fn(),
  resolveProjectRouteState,
  syncProjectRouteState,
}));

vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  assertGitHubRepoAccess,
}));

vi.mock("@repo/platform/engine/modules/github/github.service", () => ({
  getLatestCommit,
  getRepository: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/settings/settings.service", () => ({
  resolveStrategy,
  getForwardGitToServer,
}));

vi.mock("@repo/platform/engine/modules/deployments/smart-route", () => ({
  resolveSmartRoute,
}));

import {
  applyReleaseSourceToSnapshot,
  buildConfigSnapshot,
  redeployBuildSession,
  requestBuildAccess,
  resolveSnapshotTarget,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "@repo/platform/engine/modules/deployments/build.service";
import { createServiceRepo, toComposeSpec, type Database } from "@repo/db";
import { ENV_MASK, type ReleaseSource } from "@repo/core";
import {
  newFolderSessionId,
  putFolderSession,
} from "@repo/platform/engine/modules/projects/folder/session-store";
import { ComposeConfigurationError } from "@repo/platform/engine/modules/deployments/compose-configuration-error";
import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";
import * as projectConnections from "@repo/platform/engine/modules/projects/project-connection.service";

const ctx = { userId: "user-1", organizationId: "org-1" } as any;

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    organizationId: "org-1",
    environmentType: "production",
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
    buildArgs: { APP_PACKAGE: "@myorg/web" },
    advanced: { buildArgTemplateKeys: [] },
    ports: ["3000:3000"],
    dependsOn: [],
    environment: {},
    volumes: [],
    exposed: true,
    exposedPort: "3000",
    domainType: "free",
  },
];

/**
 * Put the REAL service repository reconciler behind build.service's mocked DB
 * seam. The rest of a deployment stays mocked (no clone/build/Docker), while
 * service writes are stateful and observable across the full trigger boundary.
 */
const testEncryption = createEncryption("repository-test-secret");
const configuration = createConfigurationSecrets(testEncryption);

function installStatefulComposeRepo<T extends Record<string, unknown>>(initial: T) {
  let stored = structuredClone(initial);
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    query: { service: { findMany: async () => [stored] } },
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          writes.push(configuration.openService(data));
          stored = { ...stored, ...data } as T;
        },
      }),
    }),
  } as unknown as Database;
  const real = createServiceRepo(db, testEncryption);
  repos.service.listByProject.mockImplementation(real.listByProject.bind(real));
  repos.service.reconcileFromCompose.mockImplementation(real.reconcileFromCompose.bind(real));
  return { stored: () => configuration.openService(stored), writes };
}

const criticalApiEnvironment = {
  NODE_ENV: "production",
  PORT: "4000",
  BETTER_AUTH_SECRET: "must-survive",
  GITHUB_CLIENT_SECRET: "must-survive-too",
  SMTP_HOST: "smtp.example.com",
};

function criticalApiService() {
  const compose = {
    image: "example/api:1",
    ports: ["4000"],
    environment: criticalApiEnvironment,
    volumes: ["api_data:/data"],
  };
  return {
    id: "svc-api",
    projectId: "project-1",
    name: "api",
    kind: "compose",
    enabled: true,
    exposed: false,
    exposedPort: null,
    domain: null,
    customDomain: null,
    domainType: "free",
    publicEndpoints: [],
    driftSpec: null,
    ...compose,
    importedSpec: toComposeSpec(compose),
  };
}

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

function releaseSnapshot(
  overrides: Partial<DeploymentConfigSnapshot> = {},
): DeploymentConfigSnapshot {
  return {
    ...baseSnapshot(),
    repoUrl: "https://github.com/acme/app.git",
    branch: "main",
    framework: "node",
    buildImage: "node:22-custom-builder",
    runtimeImage: "node:22-alpine",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    productionPaths: ["dist", "node_modules"],
    volumes: [],
    startCommand: "npm start",
    hasServer: true,
    hasBuild: true,
    source: "git",
    build: "buildpack",
    workload: "web",
    localPath: "/srv/old-source",
    composeServices: undefined,
    ...overrides,
  };
}

describe("buildConfigSnapshot", () => {
  it.each(["web", "worker"])("keeps the full Ruby builder image for a %s runtime", (workloadType) => {
    const snapshot = buildConfigSnapshot(baseProject({
      framework: "rails", packageManager: "bundler", buildImage: "ruby:3.4.1-alpine",
      workloadType, hasServer: workloadType === "web",
    }) as never);
    expect(snapshot.buildImage).toBe("ruby:3.4.1-alpine");
    expect(snapshot.runtimeImage).toBe(snapshot.buildImage);
  });
  it("uses the static runtime for explicitly static Ruby builds", () => {
    const snapshot = buildConfigSnapshot(baseProject({
      framework: "rails", packageManager: "bundler", buildImage: "ruby:3.4.1-slim",
      workloadType: "static", hasServer: false,
    }) as never);
    expect(snapshot.buildImage).toBe("ruby:3.4.1-slim");
    expect(snapshot.runtimeImage).toBe("ubuntu:22.04");
  });

  it("clones git snapshots instead of packaging their saved checkout path (#748)", () => {
    const snapshot = buildConfigSnapshot(
      baseProject({ gitProvider: "github", gitUrl: "https://github.com/acme/app.git" }) as never,
    );

    expect(snapshot).toMatchObject({ source: "git", localPath: undefined });
  });

  it("keeps the source path for local folder snapshots", () => {
    expect(buildConfigSnapshot(baseProject() as never).localPath).toBe("/srv/my-stack");
  });
});

describe("applyReleaseSourceToSnapshot", () => {
  it("freezes the normalized version, raw tag, and rendered image without repurposing buildImage", async () => {
    const source: ReleaseSource = {
      mode: "github",
      artifactKind: "image",
      repo: "acme/app",
      imageTemplate: "ghcr.io/acme/app:{tag}",
      pinnedVersion: "v1.2.3",
    };
    const project = baseProject({
      gitProvider: "release",
      releaseSource: source,
      localPath: null,
      framework: "node",
    });
    const snapshot = releaseSnapshot();

    await expect(applyReleaseSourceToSnapshot(project as never, snapshot)).resolves.toBe("1.2.3");

    expect(snapshot).toMatchObject({
      releaseVersion: "1.2.3",
      releaseTag: "v1.2.3",
      releaseImageRef: "ghcr.io/acme/app:v1.2.3",
      releaseRepo: "acme/app",
      repoUrl: "",
      installCommand: "",
      buildCommand: "",
      hasBuild: false,
      source: "image",
      build: "prebuilt",
      runtimeMode: "docker",
    });
    expect(snapshot.localPath).toBeUndefined();
    // buildImage is the source-build sandbox, never the application artifact.
    expect(snapshot.buildImage).toBe("node:22-custom-builder");
    expect(snapshot.runtimeImage).toBe("node:22-alpine");
    // A caller-supplied image command remains an intentional override.
    expect(snapshot.startCommand).toBe("npm start");
  });

  it("keeps legacy archive releases on the extracted-directory path", async () => {
    const previousDataDir = process.env.OPENSHIP_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "openship-release-archive-"));
    const extracted = join(dataDir, "my-stack-dist", "v2.4.0");
    mkdirSync(extracted, { recursive: true });
    process.env.OPENSHIP_DATA_DIR = dataDir;

    try {
      const source: ReleaseSource = {
        mode: "github",
        // Deliberately omitted: legacy rows default to archive.
        repo: "acme/archive-app",
        pinnedVersion: "v2.4.0",
      };
      const project = baseProject({
        gitProvider: "release",
        releaseSource: source,
        localPath: null,
        framework: "node",
      });
      const snapshot = releaseSnapshot({ source: "image", build: "prebuilt" });

      await expect(applyReleaseSourceToSnapshot(project as never, snapshot)).resolves.toBe("2.4.0");

      expect(snapshot).toMatchObject({
        releaseVersion: "2.4.0",
        releaseTag: "v2.4.0",
        releaseRepo: "acme/archive-app",
        localPath: extracted,
        repoUrl: "",
        buildCommand: "",
        installCommand: "npm ci",
        hasBuild: true,
      });
      expect(snapshot.releaseImageRef).toBeUndefined();
      expect(snapshot.buildImage).toBe("node:22-custom-builder");
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENSHIP_DATA_DIR;
      else process.env.OPENSHIP_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a container release configured as a static-file workload", async () => {
    const source: ReleaseSource = {
      mode: "github",
      artifactKind: "image",
      repo: "acme/app",
      imageTemplate: "ghcr.io/acme/app:{version}",
      pinnedVersion: "1.2.3",
    };
    const project = baseProject({
      gitProvider: "release",
      releaseSource: source,
      localPath: null,
      framework: "static",
    });
    const snapshot = releaseSnapshot({
      framework: "static",
      workload: "static",
      build: "static",
      hasServer: false,
      startCommand: "",
    });

    await expect(applyReleaseSourceToSnapshot(project as never, snapshot)).rejects.toMatchObject({
      statusCode: 400,
      code: "RELEASE_IMAGE_STATIC_UNSUPPORTED",
    });
    expect(snapshot.releaseImageRef).toBeUndefined();
  });
});

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
      organizationId: "org-1",
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
      id: "dep_old", projectId: "project-1", organizationId: "org-1",
      meta: { deployTarget: "local" } as DeploymentConfigSnapshot,
    });
    const t = await resolveSnapshotTarget(
      project({ activeDeploymentId: "dep_old", serverId: "srv_1" }),
    );
    expect(t).toMatchObject({ deployTarget: "server", serverId: "srv_1" });
  });

  it("lets cloud win over a stray serverId and drops the serverId", async () => {
    const t = await resolveSnapshotTarget(project({ cloudWorkspaceId: "ws_1", serverId: "srv_1" }));
    expect(t.deployTarget).toBe("cloud");
    expect(t.serverId).toBeUndefined();
  });

  it("lets an explicit override win over the durable binding", async () => {
    const t = await resolveSnapshotTarget(project({ serverId: "srv_1" }), {
      deployTarget: "server",
      serverId: "srv_override",
    });
    expect(t).toMatchObject({ deployTarget: "server", serverId: "srv_override" });
  });

  // Legacy rows not yet backfilled with project.serverId still resolve via the
  // active deployment's stamped meta — step 5 in the precedence.
  it("infers server from legacy active-meta serverId when the column is empty", async () => {
    repos.deployment.findById.mockResolvedValue({
      id: "dep_old", projectId: "project-1", organizationId: "org-1",
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
  it("freezes the ready Kubernetes installation and replica intent, clearing a former Docker host", async () => {
    requireClusterDeploymentTarget.mockResolvedValue({ runtime: { id: "runtime-1" } });
    const value = await resolveSnapshotTarget(project({ clusterId: "cluster-1", clusterConfig: { replicas: 3, imageRepository: "ghcr.io/team/api" }, serverId: "old-host" }));
    expect(value).toMatchObject({ deployTarget: "cluster", clusterId: "cluster-1", clusterRuntimeId: "runtime-1", clusterProjectId: "project-1", clusterConfig: { replicas: 3 }, runtimeMode: "docker" });
    expect(value.serverId).toBeUndefined();
    expect(requireClusterDeploymentTarget).toHaveBeenCalledWith("org-1", "cluster-1");
  });
  it("does not override a saved cluster target through an old deployment wizard", async () => {
    await expect(resolveSnapshotTarget(project({ clusterId: "cluster-1" }), { deployTarget: "server", serverId: "a" })).rejects.toMatchObject({ code: "CLUSTER_TARGET_CONFLICT" });
  });
  it("does not restore a removed cluster binding from the active release", async () => {
    repos.deployment.findById.mockResolvedValue({ id: "old", projectId: "project-1", organizationId: "org-1", meta: { deployTarget: "cluster", clusterId: "old-cluster" } });
    const value = await resolveSnapshotTarget(project({ activeDeploymentId: "old" }));
    expect(value.deployTarget).toBe("local");
    expect(value.clusterId).toBeUndefined();
  });
});

describe("triggerDeployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repos.deployment.listInFlightByProject.mockResolvedValue([]);

    repos.project.findById.mockResolvedValue(baseProject());
    repos.project.getEnvMap.mockResolvedValue({});
    repos.project.listEnvVarChangeMeta.mockResolvedValue([]);
    // Read by the required Compose source reconcile (git projects).
    repos.service.listByProject.mockResolvedValue([]);
    repos.service.reconcileFromCompose.mockResolvedValue({ driftedNames: [] });
    repos.serviceDeployment.latestByProject.mockResolvedValue(new Map());
    repos.deployment.listByProject.mockResolvedValue({ rows: [] });
    repos.deployment.findInProgressByCommit.mockResolvedValue(null);
    repos.deployment.getLatestSuccessfulForBranch.mockResolvedValue(null);
    repos.deployment.create.mockResolvedValue({ id: "dep-1", projectId: "project-1" });
    repos.deployment.createBuildSession.mockResolvedValue(undefined);
    repos.deployment.supersedeReconciling.mockResolvedValue(undefined);
    repos.deployment.supersedePendingDecisions.mockResolvedValue(undefined);
    repos.server.getInOrganization.mockResolvedValue({ id: "srv_remote" });

    assertGitHubRepoAccess.mockResolvedValue(undefined);
    resolveProjectRouteState.mockResolvedValue({
      primaryCustomDomain: undefined,
      primaryDomainType: undefined,
      primarySlug: undefined,
      publicEndpoints: [],
    });
    resolveProjectInfo.mockResolvedValue({ services: composeServices });
    resolveProjectSourceEnv.mockResolvedValue(undefined);
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

  it.each(["trigger", "refresh", "build-access"])(
    "rejects a preview variable set on the production runtime before %s side effects (#195)",
    async (entry) => {
      const input = { projectId: "project-1", environment: "preview" };
      const operation = entry === "build-access"
        ? requestBuildAccess(ctx, { ...input, envVars: { DATABASE_URL: "preview-only" } })
        : triggerDeployment(ctx, { ...input, refresh: entry === "refresh" });

      await expect(operation).rejects.toMatchObject({
        code: "DEPLOYMENT_ENVIRONMENT_TARGET_MISMATCH",
      });
      expect(repos.project.getEnvMap).not.toHaveBeenCalled();
      expect(repos.project.update).not.toHaveBeenCalled();
      expect(repos.project.bulkSetEnvVars).not.toHaveBeenCalled();
      expect(repos.project.mergeEnvVars).not.toHaveBeenCalled();
      expect(repos.service.reconcileFromCompose).not.toHaveBeenCalled();
      expect(syncProjectRouteState).not.toHaveBeenCalled();
      expect(repos.deployment.create).not.toHaveBeenCalled();
      expect(kickoffBuild).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "production", "preview"])(
    "keeps an isolated preview target on its own project with variable set %s (#195)",
    async (environment) => {
      const preview = baseProject({ id: "project-preview", environmentType: "preview" });
      repos.project.findById.mockResolvedValue(preview);
      repos.deployment.create.mockResolvedValue({ id: "dep-preview", projectId: preview.id });

      await triggerDeployment(ctx, { projectId: preview.id, environment });

      expect(repos.project.getEnvMap).toHaveBeenCalledWith(preview.id, environment ?? "production", null);
      expect(repos.deployment.create).toHaveBeenCalledWith(expect.objectContaining({
        projectId: preview.id,
        environment: environment ?? "production",
      }));
      expect(kickoffBuild).toHaveBeenCalledWith(preview, expect.objectContaining({ projectId: preview.id }));
    },
  );

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

  it("rejects a project that moved out of the authorized tenant before the engine read it", async () => {
    repos.project.findById.mockResolvedValue(baseProject({ organizationId: "another-org" }));
    await expect(triggerDeployment(ctx, { projectId: "project-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(assertGitHubRepoAccess).not.toHaveBeenCalled();
    expect(repos.project.getEnvMap).not.toHaveBeenCalled();
    expect(repos.deployment.create).not.toHaveBeenCalled();
    expect(kickoffBuild).not.toHaveBeenCalled();
  });

  it("uses the same frozen project env for Compose reconciliation and the deployment", async () => {
    const encryptedVersion = encrypt("1.2.3");
    repos.project.getEnvMap.mockResolvedValue({ MY_VERSION: encryptedVersion });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "abc123",
    });

    expect(resolveProjectInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "local",
        path: "/srv/my-stack",
        env: { MY_VERSION: "1.2.3" },
      }),
    );
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: { MY_VERSION: encryptedVersion } }),
    );
  });

  it("applies openship.json env to a single-app trigger without parsing Compose", async () => {
    repos.project.findById.mockResolvedValue(baseProject({ framework: "nextjs" }));
    resolveProjectSourceEnv.mockResolvedValueOnce({
      rootEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
      openshipEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
    });
    resolveServicePipelineMode.mockResolvedValueOnce({
      useServicePipeline: false,
      servicePreflightServices: [],
      useSingleAppPipeline: true,
    });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "abc123",
    });

    expect(resolveProjectInfo).not.toHaveBeenCalled();
    expect(resolveProjectSourceEnv).toHaveBeenCalledWith(
      { source: "local", path: "/srv/my-stack" },
      "",
    );
    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.NEXT_PUBLIC_API_URL)).toBe("https://api.example.com");
    expect(repos.project.mergeEnvVars).toHaveBeenCalledWith(
      "project-1",
      "production",
      [expect.objectContaining({ key: "NEXT_PUBLIC_API_URL", isSecret: false })],
      [],
    );
  });

  it("reconciles a code-only webhook when a persisted image expression depends on env", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.service.listByProject.mockResolvedValue([
      {
        id: "svc-api",
        name: "api",
        kind: "compose",
        enabled: true,
        advanced: {
          imageTemplate: {
            expression: "ghcr.io/acme/api:${MY_VERSION}",
            unresolvedVariables: [],
          },
        },
        importedSpec: { buildArgs: {} },
      },
    ]);

    await triggerDeployment(ctx, {
      projectId: "project-1",
      trigger: "webhook",
      commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
      changedPaths: ["src/index.ts"],
    });

    expect(resolveProjectInfo).toHaveBeenCalledOnce();
  });

  it("reconciles a legacy image-only row before its first provenance-aware deploy", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.service.listByProject.mockResolvedValue([
      {
        id: "svc-api",
        name: "api",
        kind: "compose",
        enabled: true,
        image: "ghcr.io/acme/api:",
        build: null,
        advanced: null,
        importedSpec: { image: "ghcr.io/acme/api:", buildArgs: {} },
      },
    ]);

    await triggerDeployment(ctx, {
      projectId: "project-1",
      trigger: "webhook",
      commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
      changedPaths: ["src/index.ts"],
    });

    expect(resolveProjectInfo).toHaveBeenCalledOnce();
  });

  it("persists exact scope and force-pull intent for an incoming multi-service hook", async () => {
    const targets = ["svc-api", "svc-worker"];
    repos.service.listByProject.mockResolvedValue([
      { id: "svc-api", name: "api", enabled: true, advanced: null },
      { id: "svc-worker", name: "worker", enabled: true, advanced: null },
      { id: "svc-db", name: "db", enabled: true, advanced: null },
    ]);
    resolveSmartRoute.mockResolvedValue({
      forceAll: false,
      serviceIds: targets,
      changedPaths: undefined,
    });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      serviceIds: targets,
      strictServiceScope: true,
      forcePullImages: true,
      trigger: "webhook",
    });

    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "webhook",
        meta: expect.objectContaining({
          targetServiceIds: targets,
          strictServiceScope: true,
          forcePullImages: true,
        }),
      }),
    );
  });

  it("persists force-pull intent for a whole-project incoming hook", async () => {
    await triggerDeployment(ctx, {
      projectId: "project-1",
      forcePullImages: true,
      trigger: "webhook",
    });

    const meta = repos.deployment.create.mock.calls.at(-1)?.[0]?.meta;
    expect(meta).toMatchObject({ forcePullImages: true });
    expect(meta.targetServiceIds).toBeUndefined();
    expect(meta.strictServiceScope).toBeUndefined();
  });

  it("rejects a stale exact target after compose reconciliation and queues nothing", async () => {
    repos.service.listByProject.mockResolvedValue([
      { id: "svc-api", name: "api", enabled: true, advanced: null },
    ]);

    await expect(
      triggerDeployment(ctx, {
        projectId: "project-1",
        serviceIds: ["svc-api", "svc-deleted"],
        strictServiceScope: true,
        forcePullImages: true,
        trigger: "webhook",
      }),
    ).rejects.toThrow(/svc-deleted/);

    expect(repos.deployment.create).not.toHaveBeenCalled();
    expect(kickoffBuild).not.toHaveBeenCalled();
  });

  it("rejects replacing a namespace provider without its dependent", async () => {
    repos.service.listByProject.mockResolvedValue([
      { id: "svc-vpn", name: "vpn", enabled: true, advanced: null },
      {
        id: "svc-sidecar",
        name: "sidecar",
        enabled: true,
        advanced: { networkMode: "service:vpn" },
      },
    ]);

    await expect(
      triggerDeployment(ctx, {
        projectId: "project-1",
        serviceIds: ["svc-vpn"],
        strictServiceScope: true,
        forcePullImages: true,
        trigger: "webhook",
      }),
    ).rejects.toThrow(/svc-sidecar/);

    expect(repos.deployment.create).not.toHaveBeenCalled();
  });

  it("uses an explicit CLI server target in preflight and the frozen deployment snapshot", async () => {
    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "abc123",
      serverId: "srv_remote",
    });

    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        deployTarget: "server",
        serverId: "srv_remote",
      }),
      expect.any(Object),
    );
    expect(repos.server.getInOrganization).toHaveBeenCalledWith("srv_remote", "org-1");
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          deployTarget: "server",
          serverId: "srv_remote",
        }),
      }),
    );
  });

  it("rejects a foreign explicit target before reconciliation or queue creation", async () => {
    repos.server.getInOrganization.mockResolvedValue(null);

    await expect(
      triggerDeployment(ctx, {
        projectId: "project-1",
        branch: "main",
        commitSha: "abc123",
        serverId: "srv_foreign",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVER_TARGET_UNAVAILABLE" });

    expect(repos.service.reconcileFromCompose).not.toHaveBeenCalled();
    expect(repos.deployment.create).not.toHaveBeenCalled();
    expect(kickoffBuild).not.toHaveBeenCalled();
  });

  it("bootstraps a declared composePath even when the first webhook changed another file (#689)", async () => {
    const commitSha = "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5";
    let storedRows: Record<string, unknown>[] = [];
    repos.service.listByProject.mockImplementation(async () => storedRows);
    repos.service.reconcileFromCompose.mockImplementation(async (_projectId, parsed) => {
      storedRows = parsed.map((service: Record<string, unknown>, index: number) => ({
        ...service,
        id: `svc-${index}`,
        projectId: "project-1",
        kind: "compose",
        enabled: true,
        exposed: service.exposed ?? false,
      }));
      return { services: storedRows, driftedNames: [] };
    });
    const actualPipeline = await vi.importActual<
      typeof import("@repo/platform/engine/modules/deployments/build-pipeline")
    >("@repo/platform/engine/modules/deployments/build-pipeline");
    resolveServicePipelineMode.mockImplementationOnce(actualPipeline.resolveServicePipelineMode);
    repos.project.findById.mockResolvedValue(
      baseProject({
        framework: "docker",
        composePath: "deploy/stack.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha,
      trigger: "webhook",
      changedPaths: ["apps/api/src/index.ts"],
    });

    expect(resolveProjectInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "github",
        owner: "acme",
        repo: "app",
        branch: "main",
        composePath: "deploy/stack.yml",
      }),
    );
    expect(repos.service.reconcileFromCompose).toHaveBeenCalledWith("project-1", composeServices);
    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        multiService: true,
        composeServices: expect.arrayContaining([
          expect.objectContaining({ name: "web", build: ".", dockerfile: "Dockerfile" }),
        ]),
      }),
    );
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          serviceDeploymentMode: "services",
          composeServices: expect.arrayContaining([
            expect.objectContaining({ name: "web", build: ".", dockerfile: "Dockerfile" }),
          ]),
        }),
      }),
    );
    expect(syncProjectRouteState).not.toHaveBeenCalled();
    expect(kickoffBuild).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({ id: "dep-1" }),
    );
  });

  it("bootstraps and reconciles a local-path compose project through the shared parser (#751)", async () => {
    let storedRows: Record<string, unknown>[] = [];
    repos.service.listByProject.mockImplementation(async () => storedRows);
    repos.service.reconcileFromCompose.mockImplementation(async (_projectId, parsed) => {
      storedRows = parsed.map((service: Record<string, unknown>, index: number) => ({
        ...service,
        id: `svc-local-${index}`,
        projectId: "project-1",
        kind: "compose",
        enabled: true,
      }));
      return { services: storedRows, driftedNames: [] };
    });
    const actualPipeline = await vi.importActual<
      typeof import("@repo/platform/engine/modules/deployments/build-pipeline")
    >("@repo/platform/engine/modules/deployments/build-pipeline");
    resolveServicePipelineMode.mockImplementationOnce(actualPipeline.resolveServicePipelineMode);
    repos.project.findById.mockResolvedValue(
      baseProject({
        composePath: "deploy/stack.yml",
        localPath: "/opt/apps/payments",
        gitProvider: "local",
        gitOwner: null,
        gitRepo: null,
      }),
    );

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      // A GitHub-only optimization must never skip a local filesystem refresh.
      changedPaths: ["src/index.ts"],
    });

    expect(resolveProjectInfo).toHaveBeenCalledWith({
      source: "local",
      path: "/opt/apps/payments",
      composePath: "deploy/stack.yml",
      env: {},
    });
    expect(repos.service.reconcileFromCompose).toHaveBeenCalledWith("project-1", composeServices);
    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        multiService: true,
        composeServices: expect.arrayContaining([expect.objectContaining({ name: "web" })]),
      }),
    );
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          serviceDeploymentMode: "services",
          composeServices: expect.arrayContaining([expect.objectContaining({ name: "web" })]),
        }),
      }),
    );
  });

  it("backfills pre-buildArgs compose baselines on a code-only webhook (#689)", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        composePath: "deploy/stack.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.service.listByProject.mockResolvedValue([
      {
        ...composeServices[0],
        projectId: "project-1",
        // A real baseline written before #689 has no `buildArgs` key at all.
        importedSpec: { image: null, build: ".", dockerfile: "Dockerfile" },
      },
    ]);

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
      trigger: "webhook",
      changedPaths: ["apps/api/src/index.ts"],
    });

    expect(resolveProjectInfo).toHaveBeenCalledOnce();
    expect(repos.service.reconcileFromCompose).toHaveBeenCalledWith("project-1", composeServices);
  });

  it("keeps the code-only webhook fast path after the compose baseline is current", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        composePath: "deploy/stack.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.service.listByProject.mockResolvedValue([
      {
        ...composeServices[0],
        projectId: "project-1",
        importedSpec: { buildArgs: { APP_PACKAGE: "@myorg/web" } },
      },
    ]);

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
      trigger: "webhook",
      changedPaths: ["apps/api/src/index.ts"],
    });

    expect(resolveProjectInfo).not.toHaveBeenCalled();
    expect(repos.service.reconcileFromCompose).not.toHaveBeenCalled();
  });

  it("reconciles native services when openship.json changes", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.service.listByProject.mockResolvedValue([
      {
        ...composeServices[0],
        projectId: "project-1",
        importedSpec: { buildArgs: { APP_PACKAGE: "@myorg/web" } },
      },
    ]);

    await triggerDeployment(ctx, {
      projectId: "project-1",
      trigger: "webhook",
      commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
      changedPaths: ["openship.json"],
    });

    expect(resolveProjectInfo).toHaveBeenCalledOnce();
    expect(repos.service.reconcileFromCompose).toHaveBeenCalledWith("project-1", composeServices);
  });

  it("refuses an existing-project redeploy when changed Compose config is unsafe", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        composePath: "deploy/stack.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.service.listByProject.mockResolvedValue([
      {
        ...composeServices[0],
        projectId: "project-1",
        importedSpec: { buildArgs: { APP_PACKAGE: "@myorg/web" } },
      },
    ]);
    resolveProjectInfo.mockRejectedValueOnce(
      new ComposeConfigurationError(
        "The Docker Compose file declares options Openship can't deploy faithfully: build.target",
      ),
    );

    await expect(
      triggerDeployment(ctx, {
        projectId: "project-1",
        branch: "main",
        commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
        trigger: "webhook",
        changedPaths: ["deploy/stack.yml"],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("build.target"),
    });

    expect(repos.service.reconcileFromCompose).not.toHaveBeenCalled();
    expect(repos.deployment.create).not.toHaveBeenCalled();
    expect(kickoffBuild).not.toHaveBeenCalled();
  });

  it.each(["ECONNRESET", "GitHub API unavailable"])(
    "stops before queuing when a required Compose source refresh fails: %s (#893)", async (message) => {
      repos.project.findById.mockResolvedValue(baseProject({
        composePath: "compose.yml", localPath: null,
        gitOwner: "acme", gitRepo: "app", gitProvider: "github", gitUrl: "https://github.com/acme/app.git",
      }));
      repos.service.listByProject.mockResolvedValue(composeServices);
      resolveProjectInfo.mockRejectedValueOnce(new Error(message));
      await expect(triggerDeployment(ctx, { projectId: "project-1", branch: "main" }))
        .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining(message) });
      expect(repos.deployment.create).not.toHaveBeenCalled();
      expect(kickoffBuild).not.toHaveBeenCalled();
    },
  );

  it.each([null, "poisoned"])(
    "preserves a %s legacy Compose value without blocking code-only webhooks (#893)",
    async (baseline) => {
      const parsed = {
        ...composeServices[0],
        environment: { MY_VAR: "B" },
        environmentTemplates: { MY_VAR: "${MY_VAR}" },
        advanced: { ...composeServices[0].advanced, environmentTemplateKeys: ["MY_VAR"] },
      };
      const state = installStatefulComposeRepo({
        ...parsed,
        environmentTemplates: undefined,
        projectId: "project-1",
        environment: { MY_VAR: "cached-private-value" },
        importedSpec: baseline ? toComposeSpec(parsed) : null,
        driftSpec: null,
      });
      repos.project.findById.mockResolvedValue(
        baseProject({
          composePath: "compose.yml",
          localPath: null,
          gitOwner: "acme",
          gitRepo: "app",
          gitProvider: "github",
          gitUrl: "https://github.com/acme/app.git",
        }),
      );
      resolveProjectInfo.mockResolvedValueOnce({ services: [parsed] });
      await triggerDeployment(ctx, {
        projectId: "project-1",
        branch: "main",
        trigger: "webhook",
        changedPaths: ["src/index.ts"],
      });
      expect(state.stored().environment).toEqual({ MY_VAR: "cached-private-value" });
      expect(state.stored().advanced?.environmentOverrideKeys).toContain("MY_VAR");
      expect(state.stored().driftSpec).toBeNull();
      expect(repos.deployment.create).toHaveBeenCalled();
      expect(kickoffBuild).toHaveBeenCalled();
    },
  );

  it("keeps critical env through trigger reconciliation when a later preflight blocks deploy", async () => {
    const state = installStatefulComposeRepo(criticalApiService());
    repos.project.findById.mockResolvedValue(
      baseProject({
        composePath: "compose.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["4000"],
      // The regression: a repo edit kept only baseline runtime keys and removed
      // auth/SMTP credentials from the Compose-owned map.
      environment: { NODE_ENV: "production", PORT: "4000" },
      volumes: ["api_data:/data"],
    };
    resolveProjectInfo.mockResolvedValue({ services: [proposed] });
    const actualPipeline = await vi.importActual<
      typeof import("@repo/platform/engine/modules/deployments/build-pipeline")
    >("@repo/platform/engine/modules/deployments/build-pipeline");
    resolveServicePipelineMode.mockImplementationOnce(actualPipeline.resolveServicePipelineMode);
    runPreflightChecks.mockRejectedValueOnce(new Error("blocked after compose reconciliation"));

    await expect(
      triggerDeployment(ctx, {
        projectId: "project-1",
        branch: "main",
        commitSha: "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5",
        changedPaths: ["compose.yml"],
      }),
    ).rejects.toThrow("blocked after compose reconciliation");

    // Source changes apply before preflight, but a failed deployment cannot
    // erase the configuration needed by the next attempt.
    expect(state.stored().environment).toEqual(criticalApiEnvironment);
    expect(state.stored().image).toBe("example/api:2");
    expect(state.stored().importedSpec).toEqual(toComposeSpec(proposed));
    expect(state.stored().driftSpec).toBeNull();
    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        composeServices: [
          expect.objectContaining({ name: "api", environment: criticalApiEnvironment }),
        ],
      }),
    );
    expect(repos.deployment.create).not.toHaveBeenCalled();
    expect(kickoffBuild).not.toHaveBeenCalled();
  });

  /**
   * `commitSha` is a free string on the wire (`openship deploy --commit 1eeaf76`,
   * the MCP deploy tool, a CI script) and git checks out an abbreviation happily —
   * so the deploy is right while the row records a name no value comparison can
   * match. That row is what the drift banner reads, which is how a project
   * deployed at `1eeaf76` came to be offered `1eeaf76` as a new commit forever.
   */
  it("stores the full sha for an abbreviated --commit ref", async () => {
    const full = "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5";
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "github", gitOwner: "acme", gitRepo: "app", localPath: null }),
    );
    getLatestCommit.mockResolvedValue({ sha: full, message: "feat: queue" });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "1eeaf76",
    });

    expect(getLatestCommit).toHaveBeenCalledWith(ctx, "acme", "app", "1eeaf76");
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: full }),
    );
  });

  it("keeps an unresolvable ref verbatim rather than failing the deploy", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "github", gitOwner: "acme", gitRepo: "app", localPath: null }),
    );
    getLatestCommit.mockResolvedValue(null); // rate limited / no credential / bad ref

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "1eeaf76",
    });

    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: "1eeaf76" }),
    );
  });

  it("spends no lookup on a sha that is already canonical", async () => {
    const full = "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5";
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "github", gitOwner: "acme", gitRepo: "app", localPath: null }),
    );

    await triggerDeployment(ctx, { projectId: "project-1", branch: "main", commitSha: full });

    expect(getLatestCommit).not.toHaveBeenCalled();
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: full }),
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

  it("keeps a rollback on its frozen image expression and environment", async () => {
    const frozenEnv = { MY_VERSION: encrypt("1.2.3") };
    const frozenSnapshot = baseSnapshot();
    frozenSnapshot.composeServices = [
      {
        name: "api",
        image: "ghcr.io/acme/api:",
        ports: [],
        dependsOn: [],
        environment: {},
        volumes: [],
        advanced: {
          imageTemplate: {
            expression: "ghcr.io/acme/api:${MY_VERSION}",
            unresolvedVariables: ["MY_VERSION"],
          },
        },
      },
    ];
    repos.project.getEnvMap.mockResolvedValue({ MY_VERSION: encrypt("9.9.9") });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      trigger: "rollback",
      reuseSnapshot: { meta: frozenSnapshot, envVars: frozenEnv },
    });

    expect(repos.project.getEnvMap).not.toHaveBeenCalled();
    expect(resolveProjectInfo).not.toHaveBeenCalled();
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: frozenEnv,
        meta: expect.objectContaining({
          composeServices: [
            expect.objectContaining({
              image: "ghcr.io/acme/api:",
              advanced: expect.objectContaining({
                imageTemplate: expect.objectContaining({
                  expression: "ghcr.io/acme/api:${MY_VERSION}",
                }),
              }),
            }),
          ],
        }),
      }),
    );
  });

  it("replays a frozen release image without authorizing a repository linked later", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        gitProvider: "github",
        gitUrl: "https://github.com/acme/current-source.git",
        gitOwner: "acme",
        gitRepo: "current-source",
        localPath: null,
        framework: "node",
      }),
    );
    const frozenImage = `ghcr.io/acme/release-app@sha256:${"c".repeat(64)}`;
    const frozenSnapshot = releaseSnapshot({
      repoUrl: "",
      localPath: undefined,
      hasBuild: false,
      source: "image",
      build: "prebuilt",
      workload: "web",
      releaseImageRef: frozenImage,
      composeServices: undefined,
    });
    resolveServicePipelineMode.mockResolvedValueOnce({
      useServicePipeline: false,
      servicePreflightServices: [],
      useSingleAppPipeline: true,
    });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "frozen-release-branch",
      trigger: "rollback",
      reuseSnapshot: {
        meta: frozenSnapshot,
        envVars: { API_KEY: "encrypted-frozen" },
      },
    });

    expect(assertGitHubRepoAccess).not.toHaveBeenCalled();
    expect(getLatestCommit).not.toHaveBeenCalled();
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: undefined,
        meta: expect.objectContaining({ releaseImageRef: frozenImage }),
      }),
    );
  });

  it("refreshes a single app from its active artifact with zero service rows (#674)", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        activeDeploymentId: "dep-live",
        framework: "nextjs",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    repos.deployment.findById.mockResolvedValue({
      id: "dep-live", projectId: "project-1", organizationId: "org-1",
      imageRef: "openship/app:bld_live",
      commitSha: "abc123",
      commitMessage: "live commit",
      createdAt: new Date("2026-08-23T00:00:00Z"),
    });
    repos.service.listByProject.mockResolvedValue([]);
    resolveServicePipelineMode.mockResolvedValue({
      useServicePipeline: false,
      servicePreflightServices: [],
      useSingleAppPipeline: true,
    });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      environment: "production",
      refresh: true,
    });

    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: "abc123",
        forceAll: false,
        meta: expect.objectContaining({
          refreshAppDeploymentId: "dep-live",
          handoverAppImage: "openship/app:bld_live",
        }),
      }),
    );
    const meta = repos.deployment.create.mock.calls.at(-1)?.[0]?.meta;
    expect(meta.targetServiceIds).toBeUndefined();
    expect(meta.refreshServiceIds).toBeUndefined();
  });

  it.each([
    { serviceIds: undefined, expected: ["svc-api", "svc-worker", "svc-db"] },
    { serviceIds: ["svc-api"], expected: ["svc-api"] },
  ])("keeps a forced topology refresh at its requested scope ($expected)", async ({ serviceIds, expected }) => {
    repos.project.findById.mockResolvedValue(baseProject({ activeDeploymentId: "dep-live" }));
    repos.deployment.findById.mockResolvedValue({
      id: "dep-live", projectId: "project-1", organizationId: "org-1", commitSha: "running-commit", createdAt: new Date("2026-08-20T00:00:00Z"),
    });
    repos.service.listByProject.mockResolvedValue([
      { id: "svc-api", name: "api", enabled: true, image: "acme/api:1" },
      { id: "svc-worker", name: "worker", enabled: true, image: "acme/worker:1" },
      { id: "svc-db", name: "db", enabled: true, image: "postgres:16" },
      { id: "svc-off", name: "disabled", enabled: false, image: "redis:7" },
    ]);
    // Without the explicit-all override this unrelated edit narrows an
    // environment resource resize to just the worker.
    repos.project.listEnvVarChangeMeta.mockResolvedValue([
      { key: "LOG_LEVEL", serviceId: "svc-worker", updatedAt: new Date("2026-08-21T00:00:00Z") },
    ]);
    await triggerDeployment(ctx, { projectId: "project-1", refresh: true, forceAll: true, serviceIds });
    expect(repos.deployment.create).toHaveBeenCalledWith(expect.objectContaining({
      commitSha: "running-commit", forceAll: false,
      meta: expect.objectContaining({ targetServiceIds: expected, refreshServiceIds: expected }),
    }));
  });

  it("returns an actionable 409 for a services project with nothing enabled", async () => {
    repos.project.findById.mockResolvedValue(baseProject({ activeDeploymentId: "dep-live" }));
    repos.deployment.findById.mockResolvedValue({
      id: "dep-live", projectId: "project-1", organizationId: "org-1",
      createdAt: new Date("2026-08-23T00:00:00Z"),
    });
    repos.service.listByProject.mockResolvedValue([]);

    await expect(
      triggerDeployment(ctx, { projectId: "project-1", refresh: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repos.deployment.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("requires an active deployment to refresh (service pipeline: %s)", async (useServicePipeline) => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        framework: "nextjs",
        activeDeploymentId: null,
      }),
    );
    resolveServicePipelineMode.mockResolvedValue({
      useServicePipeline,
      servicePreflightServices: [],
      useSingleAppPipeline: !useServicePipeline,
    });

    await expect(
      triggerDeployment(ctx, { projectId: "project-1", refresh: true }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Nothing to refresh yet — deploy the project first." });
    expect(repos.deployment.create).not.toHaveBeenCalled();
  });

  it("returns an actionable 409 for a static single-app project", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        framework: "nextjs",
        activeDeploymentId: "dep-live",
        productionMode: "static",
        hasServer: false,
      }),
    );
    repos.deployment.findById.mockResolvedValue({
      id: "dep-live", projectId: "project-1", organizationId: "org-1",
      createdAt: new Date("2026-08-23T00:00:00Z"),
    });
    resolveServicePipelineMode.mockResolvedValue({
      useServicePipeline: false,
      servicePreflightServices: [],
      useSingleAppPipeline: true,
    });

    await expect(
      triggerDeployment(ctx, { projectId: "project-1", refresh: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repos.deployment.create).not.toHaveBeenCalled();
  });

  it("returns an actionable 409 for a cloud single-app project", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        framework: "nextjs",
        activeDeploymentId: "dep-live",
        cloudWorkspaceId: "ws-live",
      }),
    );
    repos.deployment.findById.mockResolvedValue({
      id: "dep-live", projectId: "project-1", organizationId: "org-1",
      imageRef: "ws-live",
      createdAt: new Date("2026-08-23T00:00:00Z"),
    });
    resolveServicePipelineMode.mockResolvedValue({
      useServicePipeline: false,
      servicePreflightServices: [],
      useSingleAppPipeline: true,
    });

    await expect(
      triggerDeployment(ctx, { projectId: "project-1", refresh: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repos.deployment.create).not.toHaveBeenCalled();
  });
});

describe("redeployBuildSession environment snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repos.deployment.listInFlightByProject.mockResolvedValue([]);
    const project = baseProject({ activeDeploymentId: "dep-old" });
    repos.deployment.findById.mockResolvedValue({
      id: "dep-old",
      projectId: project.id,
      organizationId: project.organizationId,
      branch: "main",
      environment: "production",
      framework: "docker-compose",
      commitSha: "old-sha",
      commitMessage: "old commit",
      envVars: { FROM_OLD_RELEASE: "stale" },
      meta: baseSnapshot(),
    });
    repos.project.findById.mockResolvedValue(project);
    repos.project.getEnvMap.mockResolvedValue({ MANUAL_ENV: "keep-me" });
    repos.service.listByProject.mockResolvedValue([]);
    repos.deployment.listByProject.mockResolvedValue({ rows: [] });
    repos.deployment.getLatestSuccessfulForBranch.mockResolvedValue(null);
    repos.deployment.create.mockResolvedValue({ id: "dep-new", projectId: project.id });
    repos.deployment.createBuildSession.mockResolvedValue(undefined);
    repos.deployment.supersedeReconciling.mockResolvedValue(undefined);
    repos.deployment.supersedePendingDecisions.mockResolvedValue(undefined);
    assertGitHubRepoAccess.mockResolvedValue(undefined);
    resolveProjectSourceEnv.mockResolvedValue(undefined);
    resolveStrategy.mockResolvedValue("local");
    kickoffBuild.mockResolvedValue("session-new");
  });

  it("refuses to replay a legacy preview deployment on the production runtime (#195)", async () => {
    const old = await repos.deployment.findById();
    repos.deployment.findById.mockResolvedValue({ ...old, environment: "preview" });

    await expect(redeployBuildSession(ctx, "dep-old")).rejects.toMatchObject({
      code: "DEPLOYMENT_ENVIRONMENT_TARGET_MISMATCH",
    });
    expect(repos.project.getEnvMap).not.toHaveBeenCalled();
    expect(repos.deployment.create).not.toHaveBeenCalled();
    expect(kickoffBuild).not.toHaveBeenCalled();
  });

  it("uses current project env and keeps service scopes out of the flat snapshot", async () => {
    await redeployBuildSession(ctx, "dep-old");
    expect(repos.project.getEnvMap).toHaveBeenCalledWith("project-1", "production", null);
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: { MANUAL_ENV: "keep-me" } }),
    );
  });

  it("refreshes openship.json env for a single-app redeploy without parsing Compose", async () => {
    repos.deployment.findById.mockResolvedValue({
      id: "dep-old",
      projectId: "project-1",
      organizationId: "org-1",
      branch: "main",
      environment: "production",
      framework: "nextjs",
      commitSha: "old-sha",
      commitMessage: "old commit",
      envVars: null,
      meta: { ...baseSnapshot(), framework: "nextjs", serviceDeploymentMode: "single" },
    });
    resolveProjectSourceEnv.mockResolvedValueOnce({
      openshipEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
    });

    await redeployBuildSession(ctx, "dep-old");

    expect(resolveProjectInfo).not.toHaveBeenCalled();
    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.NEXT_PUBLIC_API_URL)).toBe("https://api.example.com");
  });

  it("updates update_status cache when resolving a new commit on redeploy", async () => {
    const project = baseProject({
      id: "project-1",
      organizationId: "org-1",
      activeDeploymentId: "dep-old",
      gitProvider: "github",
      localPath: null,
      gitOwner: "oblien",
      gitRepo: "openship",
      gitBranch: "main",
    });
    repos.project.findById.mockResolvedValue(project);
    getLatestCommit.mockResolvedValue({
      sha: "new-sha-123456789012345678901234567890",
      message: "feat: new commit",
    });

    await redeployBuildSession(ctx, "dep-old");

    expect(repos.updateStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: project.organizationId,
        projectId: project.id,
        kind: "commit",
        checkedAt: expect.any(Date),
        detail: expect.objectContaining({
          key: "oblien/openship#main",
          latestSha: "new-sha-123456789012345678901234567890",
          latestMessage: "feat: new commit",
        }),
      }),
    );
  });

  it("re-resolves a Compose image from the current project env on redeploy", async () => {
    const project = baseProject({
      activeDeploymentId: "dep-old",
      composePath: "compose.yml",
      gitProvider: "github",
      gitUrl: "https://github.com/acme/app.git",
      gitOwner: "acme",
      gitRepo: "app",
      localPath: null,
    });
    repos.project.findById.mockResolvedValue(project);
    const imageTemplate = {
      expression: "ghcr.io/acme/api:${MY_VERSION}",
      unresolvedVariables: [],
    };
    const initial = {
      name: "api",
      image: "ghcr.io/acme/api:1.0.0",
      ports: ["4000"],
      dependsOn: [],
      environment: {},
      volumes: [],
      advanced: { imageTemplate },
    };
    const state = installStatefulComposeRepo({
      id: "svc-api",
      projectId: "project-1",
      kind: "compose",
      enabled: true,
      exposed: false,
      exposedPort: null,
      domain: null,
      customDomain: null,
      domainType: "free",
      publicEndpoints: [],
      driftSpec: null,
      ...initial,
      importedSpec: toComposeSpec(initial),
    });
    const next = { ...initial, image: "ghcr.io/acme/api:2.0.0" };
    const encryptedVersion = encrypt("2.0.0");
    repos.project.getEnvMap.mockResolvedValue({ MY_VERSION: encryptedVersion });
    resolveProjectInfo.mockResolvedValue({ services: [next] });
    getLatestCommit.mockResolvedValue({ sha: "new-sha", message: "release 2.0.0" });

    await redeployBuildSession(ctx, "dep-old");

    expect(resolveProjectInfo).toHaveBeenCalledWith(
      expect.objectContaining({ env: { MY_VERSION: "2.0.0" } }),
    );
    expect(state.stored().image).toBe("ghcr.io/acme/api:2.0.0");
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: { MY_VERSION: encryptedVersion },
        meta: expect.objectContaining({
          composeServices: [
            expect.objectContaining({
              image: "ghcr.io/acme/api:2.0.0",
              advanced: expect.objectContaining({ imageTemplate }),
            }),
          ],
        }),
      }),
    );
  });

  it("queues a redeploy with preserved env when the new Compose file deletes critical keys", async () => {
    const project = baseProject({
      activeDeploymentId: "dep-old",
      composePath: "compose.yml",
      gitProvider: "github",
      gitUrl: "https://github.com/acme/app.git",
      gitOwner: "acme",
      gitRepo: "app",
      localPath: null,
    });
    repos.project.findById.mockResolvedValue(project);
    const state = installStatefulComposeRepo(criticalApiService());
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["4000"],
      environment: { NODE_ENV: "production", PORT: "4000" },
      volumes: ["api_data:/data"],
    };
    resolveProjectInfo.mockResolvedValue({ services: [proposed] });
    getLatestCommit.mockResolvedValue({ sha: "new-sha", message: "remove legacy inline env" });

    await redeployBuildSession(ctx, "dep-old");

    expect(state.stored().environment).toEqual(criticalApiEnvironment);
    expect(state.stored().driftSpec).toBeNull();
    expect(state.stored().image).toBe("example/api:2");
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: "new-sha",
        meta: expect.objectContaining({
          composeServices: [
            expect.objectContaining({ name: "api", environment: criticalApiEnvironment }),
          ],
        }),
      }),
    );
    expect(kickoffBuild).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({ id: "dep-new" }),
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
    repos.deployment.listInFlightByProject.mockResolvedValue([]);

    // An uploaded folder: no git source, framework detected as docker-compose.
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "upload", localPath: null, runtimeMode: null }),
    );
    repos.project.getEnvMap.mockResolvedValue({});
    repos.project.listEnvVars.mockResolvedValue([]);
    repos.project.bulkSetEnvVars.mockResolvedValue(undefined);
    repos.project.mergeEnvVars.mockResolvedValue(undefined);
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
    repos.server.getInOrganization.mockResolvedValue({ id: "srv_remote" });

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
    scanFolderSession.mockImplementation(async (session) => ({ services: session.services }));
    resolveFolderSessionSourceEnv.mockResolvedValue(undefined);
    resolveProjectSourceEnv.mockResolvedValue(undefined);
  });

  it("rejects a foreign folder target before service or deployment writes", async () => {
    const uploadSessionId = seedSession();
    repos.server.getInOrganization.mockResolvedValue(null);

    await expect(
      requestBuildAccess(ctx, {
        projectId: "project-1",
        uploadSessionId,
        deployTarget: "server",
        serverId: "srv_foreign",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVER_TARGET_UNAVAILABLE" });

    expect(repos.service.reconcileFromCompose).not.toHaveBeenCalled();
    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    expect(repos.deployment.create).not.toHaveBeenCalled();
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

  it("re-scans uploaded Compose build inputs with the submitted project env", async () => {
    const initial = {
      ...scannedServices[0],
      image: "ghcr.io/acme/api:base-",
      buildArgs: { RELEASE_CHANNEL: "old" },
      advanced: {
        buildArgTemplateKeys: [],
        imageTemplate: {
          expression: "ghcr.io/acme/api:${BASE}-${MY_VERSION}",
          unresolvedVariables: ["MY_VERSION"],
        },
      },
    };
    const refreshed = {
      ...initial,
      image: "ghcr.io/acme/api:base-1.2.3",
      buildArgs: { RELEASE_CHANNEL: "stable", API_ORIGIN: "${API_ORIGIN}" },
      advanced: {
        buildArgTemplateKeys: ["API_ORIGIN"],
        imageTemplate: {
          expression: "ghcr.io/acme/api:${BASE}-${MY_VERSION}",
          unresolvedVariables: [],
        },
      },
    };
    const uploadSessionId = seedSession({ services: [initial] });
    scanFolderSession.mockResolvedValueOnce({ services: [refreshed] });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      envVars: { MY_VERSION: "1.2.3" },
      services: [initial] as any,
    });

    expect(scanFolderSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadSessionId }),
      {
        env: { MY_VERSION: "1.2.3" },
        composePath: undefined,
        rememberServices: false,
      },
    );
    expect(repos.service.syncFromCompose).toHaveBeenCalledWith(
      "project-1",
      [
        expect.objectContaining({
          image: "ghcr.io/acme/api:base-1.2.3",
          buildArgs: refreshed.buildArgs,
          advanced: expect.objectContaining({
            buildArgTemplateKeys: ["API_ORIGIN"],
            imageTemplate: expect.objectContaining({ unresolvedVariables: [] }),
          }),
        }),
      ],
      { removeMissing: false },
    );
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          composeServices: [
            expect.objectContaining({
              image: "ghcr.io/acme/api:base-1.2.3",
              buildArgs: refreshed.buildArgs,
              advanced: expect.objectContaining({ buildArgTemplateKeys: ["API_ORIGIN"] }),
            }),
          ],
        }),
      }),
    );
  });

  it("#795 carries openship.json env through the deployment snapshot for Docker builds", async () => {
    const sourceServices = [
      {
        ...scannedServices[0],
        image: undefined,
        build: ".",
        dockerfile: "Dockerfile",
        buildArgs: {
          DATABASE_URI: null,
          PAYLOAD_SECRET: null,
          SERVER_URL: null,
        },
      },
    ];
    const uploadSessionId = seedSession({
      services: sourceServices,
      rootEnv: {
        DATABASE_URI: "postgres://db/app",
        PAYLOAD_SECRET: "payload-secret",
        SERVER_URL: "https://admin.example.com",
      },
      openshipEnv: {
        DATABASE_URI: { value: "postgres://db/app", secret: true },
        PAYLOAD_SECRET: { value: "payload-secret", secret: true },
        SERVER_URL: "https://admin.example.com",
      },
    });
    scanFolderSession.mockResolvedValueOnce({
      services: sourceServices,
      rootEnv: {
        DATABASE_URI: "postgres://db/app",
        PAYLOAD_SECRET: "payload-secret",
        SERVER_URL: "https://admin.example.com",
      },
      openshipEnv: {
        DATABASE_URI: { value: "postgres://db/app", secret: true },
        PAYLOAD_SECRET: { value: "payload-secret", secret: true },
        SERVER_URL: "https://admin.example.com",
      },
    });

    await requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId });

    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.DATABASE_URI)).toBe("postgres://db/app");
    expect(decrypt(captured.PAYLOAD_SECRET)).toBe("payload-secret");
    expect(decrypt(captured.SERVER_URL)).toBe("https://admin.example.com");
    expect(repos.project.mergeEnvVars).toHaveBeenCalledWith(
      "project-1",
      "production",
      expect.arrayContaining([
        expect.objectContaining({ key: "DATABASE_URI", isSecret: true }),
        expect.objectContaining({ key: "PAYLOAD_SECRET", isSecret: true }),
        expect.objectContaining({ key: "SERVER_URL", isSecret: false }),
      ]),
      [],
    );
    expect(repos.service.syncFromCompose).toHaveBeenCalledWith(
      "project-1",
      [expect.objectContaining({ buildArgs: sourceServices[0]!.buildArgs })],
      { removeMissing: false },
    );
  });

  it("keeps an operator project-env override above openship.json defaults", async () => {
    const uploadSessionId = seedSession({
      openshipEnv: { SERVER_URL: "https://source.example.com" },
      rootEnv: { SERVER_URL: "https://source.example.com" },
    });
    scanFolderSession.mockResolvedValueOnce({
      services: scannedServices,
      openshipEnv: { SERVER_URL: "https://source.example.com" },
      rootEnv: { SERVER_URL: "https://source.example.com" },
    });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      envVars: { SERVER_URL: "https://override.example.com" },
    });

    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.SERVER_URL)).toBe("https://override.example.com");
    expect(repos.project.mergeEnvVars).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      "production",
      [expect.objectContaining({ key: "SERVER_URL" })],
      [],
    );
    expect(decrypt(repos.project.mergeEnvVars.mock.calls[0][2][0].value)).toBe(
      "https://override.example.com",
    );
  });

  it("recovers only explicitly imported root .env keys from the trusted source scan", async () => {
    const uploadSessionId = seedSession({
      rootEnv: { IMPORTED: "from-dotenv", NOT_IMPORTED: "leave-out" },
    });
    scanFolderSession.mockResolvedValueOnce({
      services: scannedServices,
      rootEnv: { IMPORTED: "from-dotenv", NOT_IMPORTED: "leave-out" },
    });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      envVars: { IMPORTED: ENV_MASK },
    });

    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.IMPORTED)).toBe("from-dotenv");
    expect(captured.NOT_IMPORTED).toBeUndefined();
  });

  it("imports selected root .env keys without replacing an existing project env", async () => {
    const storedSecret = encrypt("keep-me");
    const uploadSessionId = seedSession({
      rootEnv: { IMPORTED: "from-dotenv", NOT_IMPORTED: "leave-out" },
    });
    scanFolderSession.mockResolvedValueOnce({
      services: scannedServices,
      rootEnv: { IMPORTED: "from-dotenv", NOT_IMPORTED: "leave-out" },
    });
    repos.project.getEnvMap.mockResolvedValue({ AUTH_SECRET: storedSecret });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      sourceEnvKeys: ["IMPORTED"],
    });

    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(captured.AUTH_SECRET).toBe(storedSecret);
    expect(decrypt(captured.IMPORTED)).toBe("from-dotenv");
    expect(captured.NOT_IMPORTED).toBeUndefined();
    expect(repos.project.bulkSetEnvVars).not.toHaveBeenCalled();
    expect(repos.project.mergeEnvVars).toHaveBeenCalledWith(
      "project-1",
      "production",
      [expect.objectContaining({ key: "IMPORTED" })],
      [],
    );
  });

  it("keeps a literal image override made after folder scan", async () => {
    const initial = {
      ...scannedServices[0],
      image: "ghcr.io/acme/api:1",
      advanced: {
        imageTemplate: {
          expression: "ghcr.io/acme/api:${MY_VERSION}",
          unresolvedVariables: ["MY_VERSION"],
        },
      },
    };
    const refreshed = {
      ...initial,
      image: "ghcr.io/acme/api:2",
      advanced: {
        imageTemplate: {
          expression: "ghcr.io/acme/api:${MY_VERSION}",
          unresolvedVariables: [],
        },
      },
    };
    const uploadSessionId = seedSession({ services: [initial] });
    scanFolderSession.mockResolvedValueOnce({ services: [refreshed] });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      envVars: { MY_VERSION: "2" },
      services: [{ ...initial, image: "registry.example.com/acme/api:manual" }] as any,
    });

    const persisted = repos.service.syncFromCompose.mock.calls.at(-1)?.[1]?.[0];
    expect(persisted.image).toBe("registry.example.com/acme/api:manual");
    expect(persisted.advanced?.imageTemplate).toBeUndefined();
  });

  it("does not let a stale first-deploy payload overwrite reconciled build inputs", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        composePath: "compose.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );
    const initial = {
      name: "api",
      image: "ghcr.io/acme/api:",
      ports: [],
      dependsOn: [],
      environment: {},
      volumes: [],
      buildArgs: { RELEASE_CHANNEL: "old" },
      advanced: {
        buildArgTemplateKeys: [],
        imageTemplate: {
          expression: "ghcr.io/acme/api:${MY_VERSION}",
          unresolvedVariables: ["MY_VERSION"],
        },
      },
    };
    const refreshed = {
      ...initial,
      image: "ghcr.io/acme/api:1.2.3",
      buildArgs: { RELEASE_CHANNEL: "stable", API_ORIGIN: "${API_ORIGIN}" },
      advanced: {
        buildArgTemplateKeys: ["API_ORIGIN"],
        imageTemplate: {
          expression: "ghcr.io/acme/api:${MY_VERSION}",
          unresolvedVariables: [],
        },
      },
    };
    const state = installStatefulComposeRepo({
      id: "svc-api",
      projectId: "project-1",
      kind: "compose",
      enabled: true,
      exposed: false,
      exposedPort: null,
      domain: null,
      customDomain: null,
      domainType: "free",
      publicEndpoints: [],
      driftSpec: null,
      ...initial,
      importedSpec: toComposeSpec(initial),
    });
    resolveProjectInfo.mockResolvedValue({ services: [refreshed] });
    getLatestCommit.mockResolvedValue({ sha: "new-sha", message: "release 1.2.3" });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      envVars: { MY_VERSION: "1.2.3" },
      services: [initial] as any,
      serviceDeploymentMode: "services",
    });

    expect(state.stored().image).toBe("ghcr.io/acme/api:1.2.3");
    expect(repos.service.syncFromCompose).toHaveBeenCalledWith(
      "project-1",
      [
        expect.objectContaining({
          image: "ghcr.io/acme/api:1.2.3",
          buildArgs: refreshed.buildArgs,
          advanced: expect.objectContaining({ buildArgTemplateKeys: ["API_ORIGIN"] }),
        }),
      ],
      { removeMissing: false },
    );
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          composeServices: [
            expect.objectContaining({
              image: "ghcr.io/acme/api:1.2.3",
              buildArgs: refreshed.buildArgs,
              advanced: expect.objectContaining({ buildArgTemplateKeys: ["API_ORIGIN"] }),
            }),
          ],
        }),
      }),
    );
  });

  it.each([{}, { DATABASE_URL: "stale-value" }])("refreshes connection-owned values in a submitted environment %j", async submitted => {
    const uploadSessionId = seedSession();
    const value = "postgresql://user:current@shared-db:5432/app";
    const refresh = vi.spyOn(projectConnections, "refreshConnectionEnv").mockResolvedValueOnce({ DATABASE_URL: value });
    repos.project.listEnvVars.mockResolvedValue([{ key: "DATABASE_URL", value: encrypt(value), isSecret: true, environment: "production", serviceId: null }]);
    try {
      await requestBuildAccess(ctx, {
        projectId: "project-1", uploadSessionId, environment: "production",
        envVars: { PUBLIC_SETTING: "keep", ...submitted },
      });
      const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
      expect(decrypt(captured.DATABASE_URL)).toBe(value);
      expect(decrypt(captured.PUBLIC_SETTING)).toBe("keep");
    } finally { refresh.mockRestore(); }
  });

  it("#801: preserves a stored secret submitted as the mask sentinel", async () => {
    const uploadSessionId = seedSession();
    const storedSecret = encrypt("runtime-secret");
    repos.project.listEnvVars.mockResolvedValue([
      {
        key: "AUTH_SECRET",
        value: storedSecret,
        isSecret: true,
        environment: "production",
        serviceId: null,
      },
      {
        key: "PUBLIC_SETTING",
        value: encrypt("old-value"),
        isSecret: false,
        environment: "production",
        serviceId: null,
      },
    ]);

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      environment: "production",
      envVars: { AUTH_SECRET: ENV_MASK, PUBLIC_SETTING: "new-value" },
    });

    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.AUTH_SECRET)).toBe("runtime-secret");
    expect(decrypt(captured.PUBLIC_SETTING)).toBe("new-value");
    expect(repos.project.mergeEnvVars).toHaveBeenCalledWith(
      "project-1",
      "production",
      expect.arrayContaining([
        expect.objectContaining({ key: "AUTH_SECRET", value: storedSecret, isSecret: true }),
      ]),
      [],
    );
  });

  it("keeps saved project values in the deployment and storage when the caller submits only one changed key", async () => {
    const uploadSessionId = seedSession();
    const saved = encrypt("saved-credential");
    repos.project.listEnvVars.mockResolvedValue([
      {
        key: "DATABASE_CREDENTIAL",
        value: saved,
        isSecret: true,
        environment: "production",
        serviceId: null,
      },
      {
        key: "LOG_LEVEL",
        value: encrypt("info"),
        isSecret: false,
        environment: "production",
        serviceId: null,
      },
    ]);
    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      environment: "production",
      envVars: { LOG_LEVEL: "debug" },
    });
    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.DATABASE_CREDENTIAL)).toBe("saved-credential");
    expect(decrypt(captured.LOG_LEVEL)).toBe("debug");
    expect(repos.project.bulkSetEnvVars).not.toHaveBeenCalled();
    expect(repos.project.mergeEnvVars).toHaveBeenCalledWith(
      "project-1",
      "production",
      [expect.objectContaining({ key: "LOG_LEVEL" })],
      [],
    );
  });

  it("keeps an explicitly submitted empty secret distinct from the mask sentinel", async () => {
    const uploadSessionId = seedSession();
    repos.project.listEnvVars.mockResolvedValue([
      {
        key: "AUTH_SECRET",
        value: encrypt("old-secret"),
        isSecret: true,
        environment: "production",
        serviceId: null,
      },
    ]);

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      envVars: { AUTH_SECRET: "" },
    });

    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.AUTH_SECRET)).toBe("");
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

  it("accepts migration handover pins only through the internal options", async () => {
    const uploadSessionId = seedSession();

    await requestBuildAccess(
      ctx,
      { projectId: "project-1", uploadSessionId },
      {
        handoverImages: { api: "ghcr.io/acme/api:migrated" },
        handoverAppImage: "ghcr.io/acme/api:migrated",
      },
    );

    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          handoverImages: { api: "ghcr.io/acme/api:migrated" },
          handoverAppImage: "ghcr.io/acme/api:migrated",
        }),
      }),
    );
  });

  it("ignores handover pins injected into the public request body", async () => {
    const uploadSessionId = seedSession();

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      handoverImages: { api: "attacker/image:latest" },
      handoverAppImage: "attacker/app:latest",
    } as never);

    const meta = repos.deployment.create.mock.calls.at(-1)?.[0]?.meta;
    expect(meta.handoverImages).toBeUndefined();
    expect(meta.handoverAppImage).toBeUndefined();
  });

  it.each([
    { missing: "ghcr.io/acme/api:migrated" },
    { api: "" },
    { api: "/opt/openship/static/releases/forged" },
  ])("rejects invalid internal migration handover %o", async (handoverImages) => {
    const uploadSessionId = seedSession();

    await expect(
      requestBuildAccess(ctx, { projectId: "project-1", uploadSessionId }, { handoverImages }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repos.deployment.create).not.toHaveBeenCalled();
  });

  it("preserves saved service variables omitted by a partial deployment form", async () => {
    const uploadSessionId = seedSession();
    repos.service.listByProject.mockResolvedValue([
      {
        ...scannedServices[0],
        id: "svc-api",
        projectId: "project-1",
        kind: "compose",
        enabled: true,
        environment: {
          TOKEN: "saved-service-secret",
          NODE_ENV: "production",
          URL: "${ORIGIN}/api",
        },
        advanced: { environmentTemplateKeys: ["URL"], environmentOverrideKeys: ["TOKEN"] },
      },
    ]);
    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      services: [{ ...scannedServices[0], environment: { NODE_ENV: "staging" } }] as any,
    });
    const persisted = repos.service.syncFromCompose.mock.calls.at(-1)?.[1]?.[0];
    expect(persisted.environment).toEqual({
      TOKEN: "saved-service-secret",
      NODE_ENV: "staging",
      URL: "${ORIGIN}/api",
    });
    expect(persisted.advanced).toMatchObject({
      environmentTemplateKeys: ["URL"],
      environmentOverrideKeys: ["TOKEN"],
    });
    expect(
      repos.deployment.create.mock.calls.at(-1)?.[0]?.meta.composeServices[0].environment,
    ).toEqual(persisted.environment);
  });

  // #336: the wizard sees env masked, so a deploy request can echo "••••••••".
  // The real value must be recovered (from the pre-mask session scan / stored
  // rows) before persistence — else the container launches with KEY=••••••••.
  it("#336: recovers the real env when the caller echoes the mask sentinel", async () => {
    const uploadSessionId = seedSession({
      services: [
        {
          name: "api",
          image: "ghcr.io/acme/api:1",
          ports: [],
          dependsOn: [],
          environment: { API_TOKEN: "real-token" },
          volumes: [],
        },
      ],
    });
    const requested = [
      {
        name: "api",
        image: "ghcr.io/acme/api:1",
        ports: [],
        dependsOn: [],
        environment: { API_TOKEN: "••••••••" },
        volumes: [],
      },
    ];

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      services: requested as any,
    });

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
      {
        name: "api",
        image: "x",
        ports: [],
        dependsOn: [],
        environment: { GHOST: "••••••••", REAL: "keep" },
        volumes: [],
      },
    ];

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      services: requested as any,
    });

    expect(repos.service.syncFromCompose).toHaveBeenCalledWith(
      "project-1",
      [expect.objectContaining({ name: "api", environment: { REAL: "keep" } })],
      { removeMissing: false },
    );
  });

  it.each(["upload", "stored"])(
    "#854: restores build-arg-only masks from the %s before saving the deploy snapshot",
    async (source) => {
      const service = {
        name: "api",
        image: "ghcr.io/acme/api:1",
        build: ".",
        ports: [],
        dependsOn: [],
        environment: {},
        volumes: [],
        buildArgs: { TOKEN: "original-token", INHERITED: null },
      };
      const uploadSessionId = seedSession({ services: source === "upload" ? [service] : [] });
      if (source === "stored") {
        repos.service.listByProject.mockResolvedValue([
          { ...service, id: "svc-1", kind: "compose", enabled: true },
        ]);
      }
      await requestBuildAccess(ctx, {
        projectId: "project-1",
        uploadSessionId,
        services: [
          { ...service, buildArgs: { TOKEN: ENV_MASK, INHERITED: null, GHOST: ENV_MASK } },
        ],
      } as any);
      const meta = repos.deployment.create.mock.calls.at(-1)?.[0].meta as any;
      expect(meta.composeServices[0].buildArgs).toEqual({
        TOKEN: "original-token",
        INHERITED: null,
      });
      expect(JSON.stringify(meta)).not.toContain(ENV_MASK);
    },
  );

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

  it("applies openship.json env for an unscanned single-app upload", async () => {
    const uploadSessionId = seedSession({ services: undefined });
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "upload", localPath: null, framework: "nextjs" }),
    );
    resolveFolderSessionSourceEnv.mockResolvedValueOnce({
      openshipEnv: {
        NEXT_PUBLIC_API_URL: "https://api.example.com",
        AUTH_SECRET: { value: "source-secret", secret: true },
      },
    });
    resolveServicePipelineMode.mockResolvedValueOnce({
      useServicePipeline: false,
      servicePreflightServices: [],
      useSingleAppPipeline: true,
    });

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      uploadSessionId,
      serviceDeploymentMode: "single",
    });

    expect(scanFolderSession).not.toHaveBeenCalled();
    expect(resolveFolderSessionSourceEnv).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadSessionId }),
      "",
    );
    const captured = repos.deployment.create.mock.calls.at(-1)?.[0]?.envVars;
    expect(decrypt(captured.NEXT_PUBLIC_API_URL)).toBe("https://api.example.com");
    expect(decrypt(captured.AUTH_SECRET)).toBe("source-secret");
  });

  it("does not parse or materialize compose for an explicit single-app deploy (#689)", async () => {
    const actualPipeline = await vi.importActual<
      typeof import("@repo/platform/engine/modules/deployments/build-pipeline")
    >("@repo/platform/engine/modules/deployments/build-pipeline");
    resolveServicePipelineMode.mockImplementationOnce(actualPipeline.resolveServicePipelineMode);
    repos.project.findById.mockResolvedValue(
      baseProject({
        framework: "docker",
        composePath: "deploy/stack.yml",
        gitProvider: "github",
        gitUrl: "https://github.com/acme/app.git",
        gitOwner: "acme",
        gitRepo: "app",
        localPath: null,
      }),
    );

    await requestBuildAccess(ctx, {
      projectId: "project-1",
      serviceDeploymentMode: "single",
    });

    expect(resolveProjectInfo).not.toHaveBeenCalled();
    expect(resolveProjectSourceEnv).toHaveBeenCalledOnce();
    expect(repos.service.reconcileFromCompose).not.toHaveBeenCalled();
    expect(repos.service.syncFromCompose).not.toHaveBeenCalled();
    expect(runPreflightChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ multiService: false, composeServices: [] }),
    );
    const meta = repos.deployment.create.mock.calls.at(-1)?.[0]?.meta;
    expect(meta.serviceDeploymentMode).toBe("single");
    expect(meta.composeServices).toBeUndefined();
    expect(syncProjectRouteState).toHaveBeenCalled();
    expect(kickoffBuild).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      expect.objectContaining({ id: "dep-1" }),
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
