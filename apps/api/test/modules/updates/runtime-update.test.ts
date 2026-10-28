import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "@repo/db";
import {
  seedOwner,
  installFakeRunner,
  db,
  schema,
  repos,
  type SeededOwner,
} from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { updatesRoutes } from "../../../src/modules/updates/updates.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { healthRoutes } from "../../../src/modules/health/health.routes";

const provider = vi.hoisted(() => ({ deploy: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<object>()),
  triggerDeployment: provider.deploy,
}));

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/updates", updatesRoutes);
const shipped = "1111111111111111111111111111111111111111";
beforeEach(() => {
  provider.deploy.mockReset().mockResolvedValue({ deployment: { id: "runtime-update" } });
});

async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "runtime-update-test",
      }),
    },
  });
  return {
    native: await ship.scope({ identity: "verified", organizationId: owner.orgId }),
    remote: new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }),
  };
}
async function project(owner: SeededOwner, name: string, deployed = true) {
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name,
    slug: `${owner.userId}-${name}`,
  });
  const row = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name,
    slug: `${owner.userId}-${name}`,
    gitProvider: "github",
    gitOwner: "example",
    gitRepo: name,
    gitUrl: `https://github.com/example/${name}.git`,
    gitBranch: "main",
    runtimeMode: "docker",
    framework: "laravel",
    runtimeVersion: "8.4",
    hasServer: true,
  });
  if (deployed) {
    const active = await repos.deployment.create({
      organizationId: owner.orgId,
      projectId: row.id,
      branch: "main",
      environment: "staging",
      status: "ready",
      commitSha: shipped,
      commitMessage: "Shipped source",
    });
    await repos.project.update(row.id, { activeDeploymentId: active.id });
  }
  return (await repos.project.findById(row.id))!;
}

describe("runtime update shared SDK/HTTP operation", () => {
  it("rebuilds a source runtime at the active commit without requiring source drift", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "source"),
      c = await clients(owner);
    for (const client of [c.native.updates, c.remote.updates]) {
      expect(await client.updateRuntime(p.id)).toEqual({
        project_id: p.id,
        deployment_id: "runtime-update",
      });
    }
    expect(provider.deploy).toHaveBeenCalledTimes(2);
    for (const [ctx, input] of provider.deploy.mock.calls) {
      expect(ctx).toMatchObject({ organizationId: owner.orgId, userId: owner.userId });
      expect(input).toEqual({
        projectId: p.id,
        environment: "staging",
        branch: "main",
        commitSha: shipped,
        commitMessage: "Shipped source",
        trigger: "update",
        forcePullImages: true,
        forceAll: true,
      });
    }
  });

  it("keeps an image refresh exclusive to the selected service through either client", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "images"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      gitProvider: null,
      gitOwner: null,
      gitRepo: null,
      gitUrl: null,
      framework: "docker-compose",
      runtimeVersion: null,
    });
    const wordpress = await repos.service.create({
      projectId: p.id,
      name: "wordpress",
      image: "wordpress:php8.3-apache",
    });
    await repos.service.create({ projectId: p.id, name: "db", image: "mariadb:11" });
    for (const client of [c.native.updates, c.remote.updates])
      await client.updateRuntime(p.id, { serviceIds: [wordpress.id] });
    for (const [, input] of provider.deploy.mock.calls) {
      expect(input).toMatchObject({
        serviceIds: [wordpress.id],
        strictServiceScope: true,
        trigger: "update",
        forcePullImages: true,
      });
      expect(input).not.toHaveProperty("forceAll");
    }
  });

  it("updates a repository-less WordPress template with the legacy GitHub provider default", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "wordpress-template"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      isApp: true,
      appTemplateId: "wordpress",
      framework: "docker-compose",
      runtimeVersion: null,
      gitUrl: null,
      gitOwner: null,
      gitRepo: null,
      hasBuild: false,
    });
    await db
      .update(schema.deployment)
      .set({ commitSha: null, commitMessage: null })
      .where(eq(schema.deployment.id, p.activeDeploymentId!));
    const wordpress = await repos.service.create({
      projectId: p.id,
      name: "wordpress",
      image: "wordpress:7.1.3-php8.3-apache",
    });
    await repos.service.create({ projectId: p.id, name: "db", image: "mariadb:11.4.13" });
    for (const client of [c.native.updates, c.remote.updates]) {
      await client.updateRuntime(p.id, { serviceIds: [wordpress.id] });
      await client.updateRuntime(p.id);
    }
    expect(provider.deploy).toHaveBeenCalledTimes(4);
    expect(provider.deploy.mock.calls[0][1]).toMatchObject({
      serviceIds: [wordpress.id],
      strictServiceScope: true,
      forcePullImages: true,
    });
    expect(provider.deploy.mock.calls[1][1]).toMatchObject({
      forceAll: true,
      forcePullImages: true,
    });
  });

  it("rejects disabled and cross-project scopes before deployment", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "scope"),
      other = await project(owner, "other"),
      c = await clients(owner);
    const disabled = await repos.service.create({
      projectId: p.id,
      name: "disabled",
      image: "redis:7",
      enabled: false,
    });
    const foreign = await repos.service.create({
      projectId: other.id,
      name: "foreign",
      image: "redis:7",
    });
    for (const client of [c.native.updates, c.remote.updates]) {
      for (const id of [disabled.id, foreign.id])
        await expect(client.updateRuntime(p.id, { serviceIds: [id] })).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
    }
    expect(provider.deploy).not.toHaveBeenCalled();
  });

  it("preserves the shared Actions response contract", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "actions"),
      c = await clients(owner);
    provider.deploy.mockResolvedValue({
      awaitingActions: { id: "action-request", projectId: p.id },
      skipped: true,
    });
    for (const client of [c.native.updates, c.remote.updates])
      expect(await client.updateRuntime(p.id)).toEqual({
        awaiting_actions: true,
        action_request_id: "action-request",
        project_id: p.id,
        skipped: true,
      });
  });

  it.each([
    { name: "tag", imageRef: "ghcr.io/example/app:v1.2.3", trackingRef: undefined },
    {
      name: "legacy frozen digest",
      imageRef: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
      trackingRef: undefined,
    },
    {
      name: "tracked frozen digest",
      imageRef: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
      trackingRef: "ghcr.io/example/app:v1.2.3",
    },
  ])(
    "keeps container releases on their deployed version ($name)",
    async ({ imageRef, trackingRef }) => {
      const owner = await seedOwner(),
        p = await project(owner, "release"),
        c = await clients(owner);
      await repos.project.update(p.id, {
        gitProvider: "release",
        gitUrl: null,
        gitOwner: null,
        gitRepo: null,
        sourceKind: "image",
        buildKind: "prebuilt",
        runtimeVersion: null,
        releaseSource: {
          mode: "github",
          repo: "example/app",
          artifactKind: "image",
          imageTemplate: "ghcr.io/example/app:{tag}",
        },
      });
      await db
        .update(schema.deployment)
        .set({
          meta: {
            releaseTag: "v1.2.3",
            releaseVersion: "1.2.3",
            releaseImageRef: imageRef,
            ...(trackingRef && { runtimeImageSource: trackingRef }),
          },
        })
        .where(eq(schema.deployment.id, p.activeDeploymentId!));
      for (const client of [c.native.updates, c.remote.updates]) await client.updateRuntime(p.id);
      expect(provider.deploy).toHaveBeenCalledTimes(2);
      expect(provider.deploy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ releaseVersion: "v1.2.3", forcePullImages: true }),
      );
    },
  );

  it("does not claim an all-project update when the service pipeline would omit a main release image", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "release-sidecar"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      gitProvider: "release",
      gitUrl: null,
      gitOwner: null,
      gitRepo: null,
      sourceKind: "image",
      buildKind: "prebuilt",
      runtimeVersion: null,
      releaseSource: {
        mode: "github",
        repo: "example/app",
        artifactKind: "image",
        imageTemplate: "ghcr.io/example/app:{tag}",
      },
    });
    await db
      .update(schema.deployment)
      .set({
        meta: {
          releaseTag: "v1.2.3",
          releaseVersion: "1.2.3",
          releaseImageRef: "ghcr.io/example/app:v1.2.3",
        },
      })
      .where(eq(schema.deployment.id, p.activeDeploymentId!));
    const redis = await repos.service.create({ projectId: p.id, name: "redis", image: "redis:7" });
    for (const client of [c.native.updates, c.remote.updates]) {
      await expect(client.updateRuntime(p.id)).rejects.toThrow(
        "main release image and added services",
      );
    }
    expect(provider.deploy).not.toHaveBeenCalled();
    for (const client of [c.native.updates, c.remote.updates]) {
      await client.updateRuntime(p.id, { serviceIds: [redis.id] });
    }
    expect(provider.deploy).toHaveBeenCalledTimes(2);
    for (const [, input] of provider.deploy.mock.calls) {
      expect(input).toMatchObject({
        serviceIds: [redis.id],
        strictServiceScope: true,
        forcePullImages: true,
        releaseVersion: "v1.2.3",
      });
    }
  });

  it("refuses pinned-only images instead of claiming a runtime update", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "pinned"),
      c = await clients(owner);
    await repos.service.create({
      projectId: p.id,
      name: "pinned",
      image: `redis@sha256:${"a".repeat(64)}`,
    });
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.updateRuntime(p.id)).rejects.toThrow("No mutable runtime images");
    expect(provider.deploy).not.toHaveBeenCalled();
  });

  it("can refresh a mutable build stage while keeping a runtime digest pinned", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "pinned-runtime"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      runtimeImage: `dunglas/frankenphp:1-php8.4-bookworm@sha256:${"a".repeat(64)}`,
    });
    await c.native.updates.updateRuntime(p.id);
    expect(provider.deploy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commitSha: shipped, forcePullImages: true }),
    );
  });

  it("checks the sub-app's resolved images rather than an unused parent runtime", async () => {
    const owner = await seedOwner(), p = await project(owner, "pinned-sub-app"), c = await clients(owner);
    await repos.project.update(p.id, {
      framework: "unknown", runtimeVersion: null, buildImage: "ubuntu:22.04",
    });
    const source = await repos.service.create({
      projectId: p.id, kind: "monorepo", name: "web", framework: "node",
      buildImage: `node:22-bookworm-slim@sha256:${"a".repeat(64)}`,
      buildCommand: "npm run build", startCommand: "node server.js",
    });
    await repos.service.upsertServiceDeployment({
      deploymentId: p.activeDeploymentId!, serviceId: source.id, status: "success",
      imageRef: "openship/web:bld_current", containerId: "current-container",
    });
    for (const client of [c.native.updates, c.remote.updates]) {
      await expect(client.updateRuntime(p.id, { serviceIds: [source.id] }))
        .rejects.toThrow("No mutable runtime images");
    }
    expect(provider.deploy).not.toHaveBeenCalled();
    await repos.service.update(source.id, { buildImage: "node:22-bookworm-slim" });
    await c.native.updates.updateRuntime(p.id, { serviceIds: [source.id] });
    expect(provider.deploy).toHaveBeenCalledTimes(1);
  });

  it("updates an image sidecar belonging to a static project without deploying the site", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "static-sidecar"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      framework: "vite",
      runtimeVersion: null,
      hasServer: false,
      workloadType: "static",
      runtimeMode: "bare",
    });
    const image = await repos.service.create({
      projectId: p.id,
      name: "sidecar",
      image: "redis:7",
    });
    for (const client of [c.native.updates, c.remote.updates])
      await client.updateRuntime(p.id, { serviceIds: [image.id] });
    for (const [, input] of provider.deploy.mock.calls)
      expect(input).toMatchObject({ serviceIds: [image.id], strictServiceScope: true });
  });

  it.each([false, true])(
    "updates only an image sidecar without requiring its project's retained Git revision (adopted=%s)",
    async (adopted) => {
      const owner = await seedOwner(),
        p = await project(owner, `revisionless-sidecar-${adopted}`),
        c = await clients(owner);
      await db
        .update(schema.deployment)
        .set({ commitSha: null, meta: adopted ? { adopt: true } : {} })
        .where(eq(schema.deployment.id, p.activeDeploymentId!));
      const image = await repos.service.create({
        projectId: p.id,
        name: "redis",
        image: "redis:7",
      });
      const source = await repos.service.create({
        projectId: p.id,
        name: "web",
        kind: "monorepo",
        framework: "laravel",
      });

      for (const client of [c.native.updates, c.remote.updates]) {
        await expect(client.updateRuntime(p.id, { serviceIds: [image.id] })).resolves.toEqual({
          project_id: p.id,
          deployment_id: "runtime-update",
        });
        await expect(client.updateRuntime(p.id, { serviceIds: [source.id] })).rejects.toThrow(
          "no retained Git revision",
        );
      }
      expect(provider.deploy).toHaveBeenCalledTimes(2);
      for (const [, input] of provider.deploy.mock.calls) {
        expect(input).toMatchObject({
          serviceIds: [image.id],
          strictServiceScope: true,
          forcePullImages: true,
        });
        expect(input.commitSha).toBeUndefined();
      }
    },
  );

  it("refuses a source sibling carried into a later scoped deployment", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "carried-source"),
      c = await clients(owner);
    const source = await repos.service.create({
      projectId: p.id,
      kind: "monorepo",
      name: "web",
      framework: "laravel",
    });
    const worker = await repos.service.create({
      projectId: p.id,
      kind: "monorepo",
      name: "worker",
      framework: "laravel",
    });
    const previous = await repos.deployment.create({
      organizationId: owner.orgId,
      projectId: p.id,
      branch: "main",
      status: "ready",
      commitSha: shipped,
    });
    await repos.service.upsertServiceDeployment({
      deploymentId: previous.id,
      serviceId: source.id,
      status: "success",
      imageRef: "openship/web:bld_earlier",
      containerId: "earlier-container",
    });
    await repos.service.upsertServiceDeployment({
      deploymentId: p.activeDeploymentId!,
      serviceId: source.id,
      status: "success",
      imageRef: "openship/web:bld_earlier",
      containerId: "earlier-container",
    });
    await repos.service.upsertServiceDeployment({
      deploymentId: p.activeDeploymentId!,
      serviceId: worker.id,
      status: "success",
      imageRef: "openship/worker:bld_current",
      containerId: "current-container",
    });
    await db
      .update(schema.deployment)
      .set({
        commitSha: "2222222222222222222222222222222222222222",
        meta: { targetServiceIds: [worker.id] },
      })
      .where(eq(schema.deployment.id, p.activeDeploymentId!));
    for (const client of [c.native.updates, c.remote.updates]) {
      await expect(client.updateRuntime(p.id)).rejects.toThrow("carried forward");
      await expect(client.updateRuntime(p.id, { serviceIds: [source.id] })).rejects.toThrow(
        "carried forward",
      );
      await client.updateRuntime(p.id, { serviceIds: [worker.id] });
    }
    expect(provider.deploy).toHaveBeenCalledTimes(2);
    for (const [, input] of provider.deploy.mock.calls)
      expect(input).toMatchObject({
        serviceIds: [worker.id],
        commitSha: "2222222222222222222222222222222222222222",
        strictServiceScope: true,
      });
  });

  it("rejects bare and non-versioned local source runtimes", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "unsupported"),
      c = await clients(owner);
    for (const patch of [
      { runtimeMode: "bare" },
      { runtimeMode: "bare", workloadType: "static", runtimeVersion: null },
      { workloadType: "web", gitProvider: "local", gitUrl: null, localPath: "/tmp/source" },
    ]) {
      await repos.project.update(p.id, patch);
      for (const client of [c.native.updates, c.remote.updates])
        await expect(client.updateRuntime(p.id)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
    }
    expect(provider.deploy).not.toHaveBeenCalled();
  });

  it("refreshes the Docker build images of a static source app at its active commit", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "static-build-images"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      framework: "vite",
      runtimeVersion: null,
      runtimeMode: "docker",
      workloadType: "static",
      hasServer: false,
      buildKind: "static",
      buildImage: "node:22",
    });
    for (const client of [c.native.updates, c.remote.updates]) await client.updateRuntime(p.id);
    expect(provider.deploy).toHaveBeenCalledTimes(2);
    for (const [, input] of provider.deploy.mock.calls)
      expect(input).toMatchObject({ commitSha: shipped, forcePullImages: true, forceAll: true });
  });

  it("does not infer a source revision from replayed artifacts or inline template contexts", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "replayed-source"),
      c = await clients(owner);
    await db
      .update(schema.deployment)
      .set({ trigger: "rollback", meta: { handoverAppImage: "openship/app:bld_old" } })
      .where(eq(schema.deployment.id, p.activeDeploymentId!));
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.updateRuntime(p.id)).rejects.toThrow("replayed artifact");
    const inline = await repos.service.create({
      projectId: p.id,
      name: "inline",
      advanced: { build: { dockerfile: "FROM php:8.4-apache", files: {} } },
    });
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.updateRuntime(p.id, { serviceIds: [inline.id] })).rejects.toThrow(
        "Inline template",
      );
    expect(provider.deploy).not.toHaveBeenCalled();
  });

  it("rejects a generated service whose build and runtime bases are both pinned", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "pinned-service"),
      c = await clients(owner);
    await repos.project.update(p.id, {
      runtimeImage: `dunglas/frankenphp:1-php8.4-bookworm@sha256:${"a".repeat(64)}`,
      buildImage: `php:8.4-cli-bookworm@sha256:${"b".repeat(64)}`,
    });
    const source = await repos.service.create({
      projectId: p.id,
      name: "source",
      kind: "monorepo",
      framework: "laravel",
    });
    await repos.service.upsertServiceDeployment({
      deploymentId: p.activeDeploymentId!,
      serviceId: source.id,
      status: "success",
      imageRef: "openship/source:bld_current",
    });
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.updateRuntime(p.id, { serviceIds: [source.id] })).rejects.toThrow(
        "No mutable runtime images",
      );
    expect(provider.deploy).not.toHaveBeenCalled();
  });

  it("validates input and deployed ownership and denies read-only project grants", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "authorization", false),
      c = await clients(owner);
    for (const client of [c.native.updates, c.remote.updates]) {
      await expect(client.updateRuntime(p.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      for (const input of [
        { serviceIds: [] },
        { serviceIds: ["x", "x"] },
        { commitSha: "untrusted" },
      ])
        await expect(client.updateRuntime(p.id, input as never)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
    }
    const foreign = await project(await seedOwner(), "foreign-authorization");
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.updateRuntime(foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, owner.userId));
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "project",
      resourceId: p.id,
      permissions: ["read"],
      grantedByUserId: owner.userId,
    });
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.updateRuntime(p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(provider.deploy).not.toHaveBeenCalled();
  });
});
