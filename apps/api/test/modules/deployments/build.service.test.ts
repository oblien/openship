import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  assertGitHubRepoAccess,
  getCommitByRef,
  getForwardGitToServer,
  kickoffBuild,
  repos,
  resolveProjectInfo,
  resolveProjectRouteState,
  resolveServicePipelineMode,
  resolveSmartRoute,
  resolveStrategy,
  runPreflightChecks,
  syncProjectRouteState,
} = vi.hoisted(() => ({
  assertGitHubRepoAccess: vi.fn(),
  getCommitByRef: vi.fn(),
  getForwardGitToServer: vi.fn(),
  kickoffBuild: vi.fn(),
  repos: {
    project: {
      findById: vi.fn(),
      getEnvMap: vi.fn(),
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
  },
  resolveProjectInfo: vi.fn(),
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

vi.mock("../../../src/modules/deployments/preflight", () => ({
  runPreflightChecks,
}));

vi.mock("../../../src/modules/deployments/prepare.service", () => ({
  resolveProjectInfo,
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
  getCommitByRef,
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
  applyReleaseSourceToSnapshot,
  redeployBuildSession,
  requestBuildAccess,
  resolveSnapshotTarget,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "../../../src/modules/deployments/build.service";
import type { ReleaseSource } from "@repo/core";
import {
  newFolderSessionId,
  putFolderSession,
} from "../../../src/modules/projects/folder/session-store";
import { ComposeConfigurationError } from "../../../src/modules/deployments/compose-configuration-error";

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
    repos.deployment.listInFlightByProject.mockResolvedValue([]);

    repos.project.findById.mockResolvedValue(baseProject());
    repos.project.getEnvMap.mockResolvedValue({});
    repos.project.listEnvVarChangeMeta.mockResolvedValue([]);
    // Only read by the best-effort compose-drift reconcile (git projects).
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

    assertGitHubRepoAccess.mockResolvedValue(undefined);
    resolveProjectRouteState.mockResolvedValue({
      primaryCustomDomain: undefined,
      primaryDomainType: undefined,
      primarySlug: undefined,
      publicEndpoints: [],
    });
    resolveProjectInfo.mockResolvedValue({ services: composeServices });
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
      typeof import("../../../src/modules/deployments/build-pipeline")
    >("../../../src/modules/deployments/build-pipeline");
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
    getCommitByRef.mockResolvedValue({ sha: full, message: "feat: queue" });

    await triggerDeployment(ctx, {
      projectId: "project-1",
      branch: "main",
      commitSha: "1eeaf76",
    });

    expect(getCommitByRef).toHaveBeenCalledWith(ctx, "acme", "app", "1eeaf76");
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: full }),
    );
  });

  it("keeps an unresolvable ref verbatim rather than failing the deploy", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({ gitProvider: "github", gitOwner: "acme", gitRepo: "app", localPath: null }),
    );
    getCommitByRef.mockResolvedValue(null); // rate limited / no credential / bad ref

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

    expect(getCommitByRef).not.toHaveBeenCalled();
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
    expect(getCommitByRef).not.toHaveBeenCalled();
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
      id: "dep-live",
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

  it("returns an actionable 409 for a services project with nothing enabled", async () => {
    repos.project.findById.mockResolvedValue(baseProject({ activeDeploymentId: "dep-live" }));
    repos.deployment.findById.mockResolvedValue({
      id: "dep-live",
      createdAt: new Date("2026-08-23T00:00:00Z"),
    });
    repos.service.listByProject.mockResolvedValue([]);

    await expect(
      triggerDeployment(ctx, { projectId: "project-1", refresh: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repos.deployment.create).not.toHaveBeenCalled();
  });

  it("returns an actionable 409 when there is no active deployment to refresh", async () => {
    repos.project.findById.mockResolvedValue(
      baseProject({
        framework: "nextjs",
        activeDeploymentId: null,
      }),
    );
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
      id: "dep-live",
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
      id: "dep-live",
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
    resolveStrategy.mockResolvedValue("local");
    kickoffBuild.mockResolvedValue("session-new");
  });

  it("uses current project env and keeps service scopes out of the flat snapshot", async () => {
    await redeployBuildSession(ctx, "dep-old");
    expect(repos.project.getEnvMap).toHaveBeenCalledWith("project-1", "production", null);
    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: { MANUAL_ENV: "keep-me" } }),
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

  it("does not parse or materialize compose for an explicit single-app deploy (#689)", async () => {
    const actualPipeline = await vi.importActual<
      typeof import("../../../src/modules/deployments/build-pipeline")
    >("../../../src/modules/deployments/build-pipeline");
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
