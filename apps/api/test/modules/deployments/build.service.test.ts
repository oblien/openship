import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertGitHubRepoAccess,
  kickoffBuild,
  repos,
  resolveProjectRouteState,
  resolveServicePipelineMode,
  resolveSmartRoute,
  resolveStrategy,
  runPreflightChecks,
} = vi.hoisted(() => ({
  assertGitHubRepoAccess: vi.fn(),
  kickoffBuild: vi.fn(),
  repos: {
    project: {
      findById: vi.fn(),
      getEnvMap: vi.fn(),
    },
    deployment: {
      listByProject: vi.fn(),
      getLatestSuccessfulForBranch: vi.fn(),
      create: vi.fn(),
      createBuildSession: vi.fn(),
      supersedeReconciling: vi.fn(),
      supersedePendingDecisions: vi.fn(),
    },
  },
  resolveProjectRouteState: vi.fn(),
  resolveServicePipelineMode: vi.fn(),
  resolveSmartRoute: vi.fn(),
  resolveStrategy: vi.fn(),
  runPreflightChecks: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos,
}));

// build.service imports resolveUserGitlabBaseUrl → gitlab.auth → Better Auth /
// provision-user, which needs `schema` from @repo/db. Stub the auth helper so
// this unit test never loads that graph.
vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  resolveUserGitlabBaseUrl: vi.fn(async () => "https://gitlab.com"),
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
  syncProjectRouteState: vi.fn(),
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
}));

vi.mock("../../../src/modules/deployments/smart-route", () => ({
  resolveSmartRoute,
}));

import {
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "../../../src/modules/deployments/build.service";

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
