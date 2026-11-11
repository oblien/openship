import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DockerRuntime } from "@repo/adapters";
import {
  seedOwner,
  installFakeRunner,
  db,
  schema,
  repos,
  type SeededOwner,
} from "../jobs/_harness";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { commitSourceKey } from "@repo/platform/engine/modules/projects/project-crud.service";
import { updatesRoutes } from "../../../src/modules/updates/updates.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { issuesRoutes } from "../../../src/modules/issues/issues.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

// Keep the repositories, cache, drift comparison, policy and HTTP adapters real.
// Only the external upstream request and actual redeployment are replaced.
const provider = vi.hoisted(() => ({ poll: vi.fn(), redeploy: vi.fn(), deploy: vi.fn(), runtime: vi.fn() }));
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", async (original) => ({
  ...(await original<object>()),
  resolveUpstreamDrift: provider.poll,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<object>()),
  redeployBuildSession: provider.redeploy,
  triggerDeployment: provider.deploy,
}));

vi.mock("@repo/platform/engine/lib/deployment-runtime", async original => ({
  ...await original<object>(), withDeploymentRuntime: provider.runtime,
}));

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/updates", updatesRoutes)
  .route("/api/issues", issuesRoutes);
const shipped = "1111111111111111111111111111111111111111";
const latest = "2222222222222222222222222222222222222222";
beforeEach(() => {
  provider.poll.mockReset().mockImplementation(async (_ctx, project) => ({
    supported: true,
    mode: "commit",
    key: commitSourceKey(project),
    latestSha: latest,
    latestMessage: "Next version",
  }));
  provider.redeploy.mockReset();
  provider.deploy.mockReset();
  provider.runtime.mockReset().mockRejectedValue(new Error("runtime unavailable"));
});

async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "updates-test",
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
  const input = {
    organizationId: owner.orgId,
    name,
    slug: `${owner.userId}-${name}`,
    gitProvider: "github",
    gitOwner: "example",
    gitRepo: name,
    gitBranch: "main",
  };
  const group = await repos.projectGroup.create(input);
  const row = await repos.project.create({ ...input, groupId: group.id });
  if (deployed) {
    const deployment = await repos.deployment.create({
      organizationId: owner.orgId,
      projectId: row.id,
      branch: "main",
      status: "ready",
      commitSha: shipped,
    });
    await repos.project.update(row.id, { activeDeploymentId: deployment.id });
  }
  return (await repos.project.findById(row.id))!;
}

describe("updates shared SDK/HTTP operations", () => {
  it("returns both feeds through native and HTTP clients when the shared upstream never settles", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "stalled"),
      c = await clients(owner);
    provider.poll.mockReturnValue(new Promise(() => {}));
    const [nativeUpdates, remoteUpdates, nativeIssues, remoteIssues] = await Promise.all([
      c.native.updates.list(),
      c.remote.updates.list(),
      c.native.issues.list(),
      c.remote.issues.list(),
    ]);
    for (const items of [nativeUpdates, remoteUpdates]) {
      expect(items).toMatchObject([{ projectId: p.id, behind: false, latestLabel: null }]);
    }
    expect(nativeIssues).toEqual(remoteIssues);
    expect(Array.isArray(remoteIssues.issues)).toBe(true);
    expect(provider.poll).toHaveBeenCalledTimes(1);
    expect(await repos.updateStatus.getByProject(p.id)).toMatchObject({
      detail: { latestSha: null },
    });
    await c.remote.updates.list();
    await c.native.issues.list();
    expect(provider.poll).toHaveBeenCalledTimes(1);
  });

  it("shares the upstream cache, live drift and result presentation", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "release"),
      c = await clients(owner);
    expect(await c.native.updates.scan()).toEqual({ scanned: 1, supported: 1 });
    expect(provider.poll).toHaveBeenCalledTimes(1);
    const items = await c.native.updates.list({ behindOnly: true });
    expect(items).toEqual(await c.remote.updates.list({ behindOnly: true }));
    expect(items).toMatchObject([
      {
        projectId: p.id,
        kind: "commit",
        behind: true,
        currentLabel: shipped.slice(0, 7),
        latestLabel: latest.slice(0, 7),
        checkedAt: expect.any(String),
        detail: { branch: "main" },
      },
    ]);
    expect(provider.poll).toHaveBeenCalledTimes(1);
    await db
      .update(schema.deployment)
      .set({ commitSha: latest })
      .where(eq(schema.deployment.id, p.activeDeploymentId!));
    for (const client of [c.native.updates, c.remote.updates])
      expect(await client.list({ behindOnly: true })).toEqual([]);
  });

  it("filters inaccessible projects before polls and counts, including create-only grants", async () => {
    const owner = await seedOwner(),
      visible = await project(owner, "visible"),
      hidden = await project(owner, "hidden"),
      c = await clients(owner);
    const foreign = await project(await seedOwner(), "foreign");
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, owner.userId));
    for (const [resourceType, resourceId, permissions] of [
      ["updates", "*", ["read", "write"]],
      ["project", "*", ["create"]],
      ["project", visible.id, ["read"]],
    ] as const)
      await repos.resourceGrant.upsert({
        organizationId: owner.orgId,
        userId: owner.userId,
        resourceType,
        resourceId,
        permissions: [...permissions],
        grantedByUserId: owner.userId,
      });
    for (const client of [c.native.updates, c.remote.updates]) {
      expect(await client.scan()).toEqual({ scanned: 1, supported: 1 });
      expect((await client.list()).map((row) => row.projectId)).toEqual([visible.id]);
      for (const id of [visible.id, hidden.id, foreign.id])
        await expect(client.apply(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(provider.poll.mock.calls.map(([, row]) => row.id)).toEqual([visible.id, visible.id]);
    expect(provider.redeploy).not.toHaveBeenCalled();
  });

  it("retains the update trigger and records one audit through either interface", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "apply"),
      c = await clients(owner);
    provider.redeploy.mockResolvedValue({ project_id: p.id, deployment_id: "new-deployment" });
    for (const client of [c.native.updates, c.remote.updates])
      expect(await client.apply(p.id)).toEqual({
        project_id: p.id,
        deployment_id: "new-deployment",
      });
    expect(provider.redeploy).toHaveBeenCalledTimes(2);
    for (const [ctx, id, input] of provider.redeploy.mock.calls) {
      expect(ctx).toMatchObject({ organizationId: owner.orgId, userId: owner.userId });
      expect(id).toBe(p.activeDeploymentId);
      expect(input).toEqual({ trigger: "update" });
    }
    await flushAudit();
    const events = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.resourceId, p.id));
    expect(events).toHaveLength(2);
  });

  it("uses the same exact image-update scope through native SDK and HTTP", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "images"),
      c = await clients(owner);
    await repos.project.update(p.id, { gitProvider: null, gitOwner: null, gitRepo: null });
    const local = await repos.service.create({
      projectId: p.id, name: "local", image: "my-app:custom", enabled: true,
    });
    const sidecar = await repos.service.create({
      projectId: p.id, name: "sidecar", image: "redis:7-alpine", enabled: true,
    });
    for (const [service, digest] of [[local, null], [sidecar, `sha256:${"1".repeat(64)}`]] as const) {
      await repos.service.upsertServiceDeployment({
        deploymentId: p.activeDeploymentId!, serviceId: service.id, status: "success",
        imageRef: service.image, imageDigest: digest, containerId: `container-${service.id}`,
      });
    }
    provider.poll.mockResolvedValue({
      supported: true, mode: "image",
      digestByRef: { "my-app:custom": null, "redis:7-alpine": `sha256:${"2".repeat(64)}` },
    });
    provider.deploy.mockResolvedValue({ deployment: { id: "image-update" } });
    for (const client of [c.native.updates, c.remote.updates]) {
      expect(await client.apply(p.id)).toEqual({ success: true, project_id: p.id, deployment_id: "image-update" });
    }
    expect(provider.deploy).toHaveBeenCalledTimes(2);
    for (const [ctx, input] of provider.deploy.mock.calls) {
      expect(ctx).toMatchObject({ organizationId: owner.orgId, userId: owner.userId });
      expect(input).toMatchObject({
        projectId: p.id, trigger: "update", serviceIds: [sidecar.id], strictServiceScope: true,
      });
    }
    expect(provider.redeploy).not.toHaveBeenCalled();
  });

  it.each([true, false])("carries observed image drift through real repositories, HTTP and native SDK (inspectable=%s)", async inspectable => {
    const owner = await seedOwner(), p = await project(owner, `image-observation-${inspectable}`), c = await clients(owner);
    await repos.project.update(p.id, { gitOwner: null, gitRepo: null });
    const image = await repos.service.create({ projectId: p.id, name: "web", image: "nginx:alpine", enabled: true });
    await repos.service.upsertServiceDeployment({
      deploymentId: p.activeDeploymentId!, serviceId: image.id, status: "success",
      imageRef: image.image, imageDigest: null, containerId: "observed-container",
    });
    provider.poll.mockResolvedValue({ supported: true, mode: "image", digestByRef: { "nginx:alpine": `sha256:${"b".repeat(64)}` } });
    const runtime = await DockerRuntime.create({ transport: "socket" });
    const oldImage = `sha256:${"1".repeat(64)}`, newImage = `sha256:${"2".repeat(64)}`;
    vi.spyOn(runtime, "docker", "get").mockReturnValue({
      getContainer: () => ({ inspect: async () => {
        if (!inspectable) throw Object.assign(new Error("missing"), { statusCode: 404 });
        return { Image: oldImage, State: { Status: "running", Running: true }, NetworkSettings: { Ports: {} }, HostConfig: {} };
      } }),
      getImage: (ref: string) => ({ inspect: async () => ({ Id: ref === oldImage ? oldImage : newImage, RepoDigests: [] }) }),
    } as never);
    provider.runtime.mockImplementation(async (deployment, read) => {
      expect(deployment).toMatchObject({ organizationId: owner.orgId, projectId: p.id });
      return read(runtime);
    });
    try {
      for (const updates of [c.native.updates, c.remote.updates]) {
        const result = await updates.list({ behindOnly: true });
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ projectId: p.id, behind: inspectable, unverified: !inspectable,
          detail: { services: [expect.objectContaining({ unknown: !inspectable })] },
        });
        if (!inspectable) await expect(updates.apply(p.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      expect(await c.native.projects.getCommitStatus(p.id)).toMatchObject({
        supported: true, mode: "image", unverified: !inspectable,
        services: [expect.objectContaining({ unknown: !inspectable })],
      });
      const stored = await repos.service.listByDeployment(p.activeDeploymentId!);
      expect(stored[0].imageDigest).toBeNull();
      expect(provider.deploy).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  it("refuses undeployed updates, invalid inputs and revoked membership before provider work", async () => {
    const owner = await seedOwner(),
      p = await project(owner, "undeployed", false),
      c = await clients(owner);
    for (const client of [c.native.updates, c.remote.updates]) {
      await expect(client.apply(p.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(client.list({ behindOnly: "yes" } as never)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    await db.delete(schema.member).where(eq(schema.member.userId, owner.userId));
    for (const client of [c.native.updates, c.remote.updates])
      await expect(client.scan()).rejects.toBeDefined();
    expect(provider.poll).not.toHaveBeenCalled();
    expect(provider.redeploy).not.toHaveBeenCalled();
  });
});
