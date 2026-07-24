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
      listByGroup: vi.fn(),
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
  resolveDeploymentProject,
  triggerDeployment,
  type DeploymentConfigSnapshot,
} from "../../../src/modules/deployments/build.service";

const ctx = {
  userId: "user-1",
  organizationId: "org-1",
  role: "member",
  tokenScope: null,
} as any;

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    organizationId: "org-1",
    groupId: "app-1",
    environmentName: "Production",
    environmentSlug: "production",
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
    repos.project.listByGroup.mockResolvedValue([baseProject()]);
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

  it("routes an explicit preview deploy to the sibling project for its branch", async () => {
    const production = baseProject();
    const previewOne = baseProject({
      id: "project-preview-one",
      environmentName: "Feature one",
      environmentSlug: "feature-one",
      environmentType: "preview",
      gitBranch: "feature/one",
    });
    const previewTwo = baseProject({
      id: "project-preview-two",
      environmentName: "Feature two",
      environmentSlug: "feature-two",
      environmentType: "preview",
      gitBranch: "feature/two",
    });
    repos.project.findById.mockResolvedValue(production);
    repos.project.listByGroup.mockResolvedValue([production, previewOne, previewTwo]);
    repos.deployment.create.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "dep-preview",
      ...input,
    }));

    await triggerDeployment(ctx, {
      projectId: "project-1",
      environment: "preview",
      branch: "feature/two",
      commitSha: "preview123",
    });

    expect(repos.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-preview-two",
        environment: "preview",
        branch: "feature/two",
      }),
    );
    expect(kickoffBuild).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-preview-two" }),
      expect.objectContaining({ id: "dep-preview", projectId: "project-preview-two" }),
    );
  });

  it("rejects a preview deploy when no isolated preview project exists", async () => {
    repos.project.listByGroup.mockResolvedValue([baseProject()]);

    await expect(
      resolveDeploymentProject(ctx, "project-1", "preview", "feature/missing"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DEPLOYMENT_ENVIRONMENT_NOT_CONFIGURED",
    });
  });

  it("requires restricted principals to name a sibling environment project directly", async () => {
    await expect(
      resolveDeploymentProject(
        { ...ctx, role: "restricted" },
        "project-1",
        "preview",
        "feature/one",
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DEPLOYMENT_ENVIRONMENT_PROJECT_REQUIRED",
    });
    expect(repos.project.listByGroup).not.toHaveBeenCalled();
  });
});
