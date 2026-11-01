import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment, Project } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  exists: vi.fn(),
  trigger: vi.fn(),
  retention: vi.fn(),
  currentTarget: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@repo/adapters", () => ({
  DockerRuntime: class {
    imageExistsLocally = h.exists;
  },
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.trigger,
  resolveSnapshotTarget: h.currentTarget,
}));
vi.mock("@repo/platform/engine/modules/deployments/retained-artifacts", () => ({
  retainedArtifacts: h.retention,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  withDeploymentRuntime: async (dep: unknown, work: (runtime: unknown) => unknown) => {
    h.resolve(dep);
    return work(new (DockerRuntime as unknown as new () => unknown)());
  },
}));
import { DockerRuntime } from "@repo/adapters";
import { retryBuiltDeployment } from "@repo/platform/engine/modules/deployments/retry-built-deployment";

const imageId = `sha256:${"a".repeat(64)}`;
const ctx = { organizationId: "org", userId: "member" } as ExecutionContext;
const project = {
  id: "project",
  organizationId: "org",
  serverId: "server",
  runtimeMode: "docker",
} as Project;
const attempt = (): Deployment =>
  ({
    id: "failed",
    projectId: "project",
    organizationId: "org",
    status: "failed",
    artifactRetainedAt: new Date(),
    branch: "main",
    commitSha: "a".repeat(40),
    environment: "production",
    envVars: { SECRET: "encrypted-old" },
    meta: {
      deployTarget: "server",
      serverId: "server",
      runtimeMode: "docker",
      serviceDeploymentMode: "single",
      repoUrl: "https://github.com/old/repo.git",
      configurationSecretsPreserved: true,
      completedBuildArtifacts: {
        version: 1,
        images: [{ imageRef: "openship/app:bld_done", imageId }],
      },
    },
  }) as Deployment;
beforeEach(() => {
  vi.clearAllMocks();
  h.exists.mockResolvedValue(true);
  h.currentTarget.mockResolvedValue({
    deployTarget: "server",
    serverId: "server",
    runtimeMode: "docker",
  });
  h.retention.mockResolvedValue({ retryableDeploymentId: "failed" });
  h.trigger.mockResolvedValue({ deployment: { id: "retry" } });
});

describe("retry a completed build through the normal pipeline", () => {
  it("creates a new attempt from exact images/configuration and the saved source revision", async () => {
    const target = attempt();
    expect(await retryBuiltDeployment(ctx, target, project)).toEqual({
      success: true,
      deployment_id: "retry",
      project_id: "project",
    });
    expect(h.exists).toHaveBeenCalledExactlyOnceWith(imageId);
    const command = h.trigger.mock.calls[0]![1];
    expect(command).toMatchObject({
      trigger: "retry",
      projectId: "project",
      commitSha: target.commitSha,
      reuseSnapshot: {
        envVars: { SECRET: "encrypted-old" },
        meta: {
          handoverAppImage: imageId,
          refreshAppDeploymentId: "failed",
          retryBuildFromDeploymentId: "failed",
          repoUrl: "https://github.com/old/repo.git",
        },
      },
    });
    expect(command.reuseSnapshot.meta.completedBuildArtifacts).toEqual(
      (target.meta as { completedBuildArtifacts: unknown }).completedBuildArtifacts,
    );
    expect(command.reuseSnapshot.meta.forcePullImages).toBeUndefined();
    expect(h.trigger).toHaveBeenCalledTimes(1);
  });

  it("pins a Compose cohort and restricts the retry to its recorded services", async () => {
    const target = attempt();
    target.meta = {
      ...(target.meta as object),
      serviceDeploymentMode: "services",
      composeServices: [
        { name: "api", build: "." },
        { name: "db", image: "postgres:16" },
      ],
      completedBuildArtifacts: {
        version: 1,
        images: [
          { imageRef: "openship/api:bld_done", imageId, serviceId: "api", serviceName: "api" },
          { imageRef: "postgres:16", imageId, serviceId: "db", serviceName: "db" },
        ],
      },
    };
    await retryBuiltDeployment(ctx, target, project);
    expect(h.trigger.mock.calls[0]![1]).toMatchObject({
      serviceIds: ["api", "db"],
      strictServiceScope: true,
      reuseSnapshot: {
        meta: {
          handoverImages: { api: imageId, db: imageId },
          targetServiceIds: ["api", "db"],
          refreshServiceIds: ["api", "db"],
          strictServiceScope: true,
        },
      },
    });
  });

  it("retries a primary app image without source or restricting its attached services to app scope", async () => {
    const target = attempt();
    target.meta = {
      ...(target.meta as object),
      serviceDeploymentMode: "services",
      primaryAppServiceName: "app",
      composeServices: [
        { kind: "monorepo", name: "app" },
        { kind: "compose", name: "db", image: "postgres:16" },
      ],
      releaseCommands: ["run-migrations"],
      roles: [{ name: "queue", kind: "worker", command: "run-queue", replicas: 1 }],
    };
    await retryBuiltDeployment(ctx, target, project);
    const command = h.trigger.mock.calls[0]![1];
    expect(command.serviceIds).toBeUndefined();
    expect(command.reuseSnapshot.meta).toMatchObject({
      primaryAppServiceName: "app",
      handoverAppImage: imageId,
      refreshAppDeploymentId: target.id,
      releaseCommands: ["run-migrations"],
      roles: [{ name: "queue", kind: "worker", command: "run-queue", replicas: 1 }],
    });
    expect(command.reuseSnapshot.meta.handoverImages).toBeUndefined();
  });

  it.each(["cancelled", "ready", "partial_failure", "building"])(
    "refuses %s attempts",
    async (status) => {
      await expect(
        retryBuiltDeployment(ctx, { ...attempt(), status }, project),
      ).rejects.toMatchObject({ code: "DEPLOYMENT_BUILD_UNAVAILABLE" });
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );

  it("refuses a missing or superseded artifact without building or pulling", async () => {
    h.exists.mockResolvedValue(false);
    await expect(retryBuiltDeployment(ctx, attempt(), project)).rejects.toMatchObject({
      code: "DEPLOYMENT_BUILD_UNAVAILABLE",
    });
    expect(h.trigger).not.toHaveBeenCalled();
    h.retention.mockResolvedValue({ retryableDeploymentId: "newer" });
    h.resolve.mockClear();
    await expect(retryBuiltDeployment(ctx, attempt(), project)).rejects.toMatchObject({
      code: "DEPLOYMENT_BUILD_UNAVAILABLE",
    });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("denies another organization/project before any host inspection", async () => {
    await expect(
      retryBuiltDeployment({ ...ctx, organizationId: "other" }, attempt(), project),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      retryBuiltDeployment(ctx, { ...attempt(), projectId: "other" }, project),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(h.retention).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("does not replay a saved artifact onto a changed server or runtime", async () => {
    h.currentTarget.mockResolvedValue({
      deployTarget: "server",
      serverId: "other",
      runtimeMode: "docker",
    });
    await expect(retryBuiltDeployment(ctx, attempt(), project)).rejects.toMatchObject({
      code: "DEPLOYMENT_RETRY_TARGET_CHANGED",
    });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
});
