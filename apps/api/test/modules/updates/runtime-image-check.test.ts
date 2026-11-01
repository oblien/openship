import { beforeEach, expect, it, vi } from "vitest";
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
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const registry = vi.hoisted(() => ({ digest: vi.fn() }));
vi.mock("@repo/platform/engine/lib/image-registry", async (original) => ({
  ...(await original<object>()),
  resolveLatestImageDigest: registry.digest,
}));
installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/updates", updatesRoutes);
const OLD = `sha256:${"a".repeat(64)}`,
  NEW = `sha256:${"b".repeat(64)}`;
beforeEach(() => {
  registry.digest.mockReset().mockResolvedValue(NEW);
});
async function setMeta(id: string, meta: Record<string, unknown>) {
  await db.update(schema.deployment).set({ meta }).where(eq(schema.deployment.id, id));
}

async function fixture() {
  const owner = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "runtime-check",
    slug: owner.userId,
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "runtime-check",
    slug: owner.userId,
    gitProvider: "github",
    gitUrl: "https://github.com/example/app.git",
    gitOwner: "example",
    gitRepo: "app",
    framework: "laravel",
    runtimeVersion: "8.4",
    runtimeMode: "docker",
    hasServer: true,
  });
  const deployment = await repos.deployment.create({
    projectId: project.id,
    organizationId: owner.orgId,
    branch: "main",
    status: "ready",
    commitSha: "1".repeat(40),
    imageRef: "openship/user:bld_current",
  });
  await repos.project.update(project.id, { activeDeploymentId: deployment.id });
  return { owner, project, deployment };
}
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "runtime-check",
      }),
    },
  });
  return [
    (await ship.scope({ identity: "verified", organizationId: owner.orgId })).updates,
    new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }).updates,
  ];
}

it("compares recorded source image bases independently of newer Git commits", async () => {
  const { owner, project, deployment } = await fixture();
  await setMeta(deployment.id, {
    runtimeImages: {
      app: [
        { ref: "php:8.4-cli-bookworm", digest: OLD },
        { ref: "dunglas/frankenphp:1-php8.4-bookworm", digest: NEW },
      ],
      artifacts: { app: deployment.imageRef },
    },
  });
  for (const client of await clients(owner)) {
    const result = await client.checkRuntime(project.id);
    expect(Object.keys(result).sort()).toEqual(["checkedAt", "images"]);
    expect(result.images).toMatchObject([
      {
        ref: "php:8.4-cli-bookworm",
        currentDigest: OLD,
        latestDigest: NEW,
        status: "update_available",
      },
      { ref: "dunglas/frankenphp:1-php8.4-bookworm", currentDigest: NEW, status: "current" },
    ]);
  }
  expect(registry.digest).toHaveBeenCalledWith("php:8.4-cli-bookworm", { refresh: true });
});

it("does not claim a source base is current when its deployed baseline is missing or belongs to another artifact", async () => {
  const { owner, project, deployment } = await fixture();
  for (const meta of [
    {},
    {
      runtimeImages: {
        app: [{ ref: "php:8.4-cli-bookworm", digest: NEW }],
        artifacts: { app: "openship/user:bld_another" },
      },
    },
  ]) {
    await setMeta(deployment.id, meta);
    const result = await (await clients(owner))[0]!.checkRuntime(project.id);
    expect(result.images.length).toBeGreaterThan(0);
    expect(
      result.images.every((image) => image.status === "unknown" && image.currentDigest === null),
    ).toBe(true);
  }
});

it("scopes checks to one image service and preserves digest pins", async () => {
  const { owner, project, deployment } = await fixture();
  const web = await repos.service.create({
    projectId: project.id,
    name: "wordpress",
    image: "wordpress:php8.3-apache",
  });
  const pinned = await repos.service.create({
    projectId: project.id,
    name: "db",
    image: `mariadb@${OLD}`,
  });
  await repos.service.upsertServiceDeployment({
    deploymentId: deployment.id,
    serviceId: web.id,
    serviceName: web.name,
    status: "success",
    imageRef: web.image,
    imageDigest: `docker.io/library/wordpress@${OLD}`,
  });
  for (const client of await clients(owner)) {
    const result = await client.checkRuntime(project.id, { serviceIds: [web.id] });
    expect(result.images).toMatchObject([
      { serviceId: web.id, currentDigest: OLD, status: "update_available" },
    ]);
    const fixed = await client.checkRuntime(project.id, { serviceIds: [pinned.id] });
    expect(fixed.images).toMatchObject([{ status: "pinned", latestDigest: null }]);
  }
  expect(registry.digest.mock.calls.every(([ref]) => ref === web.image)).toBe(true);
});

it("keeps unreachable registries unknown and never compares an edited tag with the old image", async () => {
  const { owner, project, deployment } = await fixture();
  const web = await repos.service.create({
    projectId: project.id,
    name: "web",
    image: "private.example/app:new",
  });
  await repos.service.upsertServiceDeployment({
    deploymentId: deployment.id,
    serviceId: web.id,
    serviceName: web.name,
    status: "success",
    imageRef: "private.example/app:old",
    imageDigest: OLD,
  });
  registry.digest.mockResolvedValue(null);
  const result = await (
    await clients(owner)
  )[0]!.checkRuntime(project.id, { serviceIds: [web.id] });
  expect(result.images).toMatchObject([
    { currentDigest: null, latestDigest: null, status: "unknown" },
  ]);
});

it("checks the retained mutable release tag after its deployed image was frozen to a digest", async () => {
  const { owner, project, deployment } = await fixture();
  await repos.project.update(project.id, {
    gitProvider: "release",
    gitUrl: null,
    gitOwner: null,
    gitRepo: null,
    runtimeVersion: null,
    framework: "docker",
    sourceKind: "image",
    buildKind: "prebuilt",
    releaseSource: {
      mode: "github",
      repo: "example/app",
      artifactKind: "image",
      imageTemplate: "ghcr.io/example/app:{tag}",
    },
  });
  await setMeta(deployment.id, {
    releaseImageRef: `ghcr.io/example/app@${OLD}`,
    runtimeImageSource: "ghcr.io/example/app:v1.2.3",
    releaseVersion: "1.2.3",
    releaseTag: "v1.2.3",
  });
  for (const client of await clients(owner)) {
    const result = await client.checkRuntime(project.id);
    expect(result.images).toContainEqual(
      expect.objectContaining({
        ref: "ghcr.io/example/app:v1.2.3",
        currentDigest: OLD,
        latestDigest: NEW,
        status: "update_available",
      }),
    );
  }
});

it("allows read-only checks while denying foreign project and service scopes", async () => {
  const { owner, project } = await fixture(),
    other = await fixture();
  const foreign = await repos.service.create({
    projectId: other.project.id,
    name: "foreign",
    image: "redis:7",
  });
  await db
    .update(schema.member)
    .set({ role: "restricted" })
    .where(eq(schema.member.userId, owner.userId));
  await repos.resourceGrant.upsert({
    organizationId: owner.orgId,
    userId: owner.userId,
    resourceType: "project",
    resourceId: project.id,
    permissions: ["read"],
    grantedByUserId: owner.userId,
  });
  for (const client of await clients(owner)) {
    await expect(client.checkRuntime(project.id)).resolves.toMatchObject({
      images: expect.any(Array),
    });
    await expect(client.updateRuntime(project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.checkRuntime(other.project.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client.checkRuntime(project.id, { serviceIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  }
});

it("checks a namespace provider independently without applying rollout dependency constraints", async () => {
  const { owner, project } = await fixture();
  const vpn = await repos.service.create({
    projectId: project.id,
    name: "vpn",
    image: "example/vpn:stable",
  });
  await repos.service.create({
    projectId: project.id,
    name: "consumer",
    image: "example/app:1",
    advanced: { networkMode: "service:vpn" },
  });
  for (const client of await clients(owner)) {
    const result = await client.checkRuntime(project.id, { serviceIds: [vpn.id] });
    expect(result.images.map((image) => image.serviceId)).toEqual([vpn.id]);
  }
});
