import { describe, expect, it, vi } from "vitest";
import { repos, seedOwner } from "../modules/jobs/_harness";
import type { ExecutionContext } from "@repo/platform";
import { Hono } from "hono";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { projectRoutes } from "../../src/modules/projects/project.routes";
import { healthRoutes } from "../../src/modules/health/health.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { canRouteSelfApp } from "@repo/platform/engine/lib/self-app-routing";
import {
  observedLoopbackPublishFromUrl,
  reserveObservedLoopbackPublishes,
} from "@repo/platform/engine/modules/deployments/observed-host-port-claims";

const repair = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
// Stop at host execution for the transport test; repository reads, resource
// authorization and the instance-role decision remain real.
vi.mock("@repo/platform/engine/modules/projects/project.service", async (original) => ({
  ...(await original<object>()),
  retryProjectRouting: repair,
}));
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);

async function setup(instanceAdmin = true) {
  const owner = await seedOwner({ instanceAdmin });
  const user = (await repos.user.findById(owner.userId))!;
  const input = {
    name: "Openship",
    slug: `openship-${owner.userId}`,
    organizationId: owner.orgId,
    appTemplateId: "openship",
  };
  const group = await repos.projectGroup.create(input);
  const project = await repos.project.create({ ...input, groupId: group.id });
  const deployment = (await repos.deployment.create({
    projectId: project.id,
    organizationId: owner.orgId,
    branch: "main",
    trigger: "adopt",
    status: "ready",
    meta: { adopt: true, runtimeMode: "bare" },
  }))!;
  await repos.project.setActiveDeployment(project.id, deployment.id);
  const ctx: ExecutionContext = {
    userId: user.id,
    user: { id: user.id, email: user.email, name: user.name },
    organizationId: owner.orgId,
    role: "owner",
    membershipId: "seeded-owner",
    sessionId: "verified-session",
    sessionKind: "native",
    clientIp: null,
    userAgent: null,
    traceId: "self-route-test",
  };
  return { ctx, project, deployment, owner };
}

describe("self-app route repair authorization (#879)", () => {
  it("allows an instance administrator with an unrestricted identity to repair its adopted dashboard", async () => {
    const { ctx, project } = await setup();
    expect(await canRouteSelfApp(ctx, project.id)).toBe(true);
  });

  it.each([true, false])(
    "HTTP and native repair preserve the persisted instance authority (%s)",
    async (admin) => {
      const { ctx, project, owner } = await setup(admin);
      repair.mockClear();
      const ship = createShip({
        platform: getPlatformKernel(),
        identity: { resolve: async () => ({ user: ctx.user, sessionId: ctx.sessionId }) },
      });
      const native = await ship.scope({ identity: "verified", organizationId: ctx.organizationId });
      const remote = new OpenshipClient({
        baseUrl: "http://openship.test",
        token: owner.token,
        organizationId: ctx.organizationId,
        fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
      });
      for (const client of [native, remote]) {
        expect(await client.projects.retryRouting(project.id)).toEqual({ ok: true });
        expect(repair).toHaveBeenLastCalledWith(project.id, ctx.organizationId, {
          isSelfApp: admin,
        });
      }
      expect(repair).toHaveBeenCalledTimes(2);
    },
  );

  it("does not elevate a project owner based on the editable app-template marker", async () => {
    const { ctx, project } = await setup(false);
    expect(await canRouteSelfApp(ctx, project.id)).toBe(false);
  });

  it("keeps administrator tokens constrained by organization, scopes, expiry and read-only access", async () => {
    const { ctx, project } = await setup();
    for (const restricted of [
      { ...ctx, credential: { organizationId: ctx.organizationId, readOnly: false } },
      { ...ctx, credential: { organizationId: null, readOnly: true } },
      { ...ctx, credential: { organizationId: null, readOnly: false, expiresAt: Date.now() - 1 } },
      { ...ctx, tokenScope: { tokenId: "scoped-token" } },
      { ...ctx, organizationId: "another-organization" },
    ])
      expect(await canRouteSelfApp(restricted, project.id)).toBe(false);
  });

  it("requires an adopted self-app deployment, not only the project label", async () => {
    const { ctx, project, deployment } = await setup();
    await repos.deployment.updateStatus(deployment.id, "ready", { meta: {} });
    expect(await canRouteSelfApp(ctx, project.id)).toBe(false);
    await repos.deployment.updateStatus(deployment.id, "ready", { meta: { adopt: true } });
    await repos.project.update(project.id, { appTemplateId: null });
    expect(await canRouteSelfApp(ctx, project.id)).toBe(false);
  });

  it("converges repeatedly with the dashboard service's durable claim without promoting a different owner", async () => {
    const { project } = await setup();
    const service = await repos.service.create({
      projectId: project.id,
      name: "dashboard",
      ports: ["3001:3001"],
    });
    const target = {
      targetKey: `server:${project.id}` as const,
      legacyTargetKeys: [],
      stable: true,
    };
    const claim = await repos.hostPortClaim.reserveHostPortClaim({
      targetKey: target.targetKey,
      projectId: project.id,
      serviceId: service.id,
      port: 3001,
      containerPort: 3001,
    });
    const publish = observedLoopbackPublishFromUrl({
      targetUrl: "http://127.0.0.1:3001",
      serviceId: service.id,
      containerPort: 3001,
    });
    for (let i = 0; i < 2; i++) {
      await reserveObservedLoopbackPublishes({
        target,
        projectId: project.id,
        publishes: [publish],
      });
    }
    expect(await repos.hostPortClaim.listHostPortClaims(target.targetKey)).toMatchObject([
      { id: claim.id, serviceId: service.id, port: 3001, containerPort: 3001 },
    ]);
    await expect(
      reserveObservedLoopbackPublishes({
        target,
        projectId: project.id,
        publishes: [{ serviceId: null, hostPort: 3001, containerPort: 3001 }],
      }),
    ).rejects.toMatchObject({ name: "HostPortClaimConflictError" });
    expect(await repos.hostPortClaim.listHostPortClaims(target.targetKey)).toMatchObject([
      { id: claim.id, serviceId: service.id },
    ]);
  });
});
