import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "@repo/db";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { repos, db, schema, seedOwner } from "../jobs/_harness";
import { seedProject, seedDeployment, setActive } from "../../helpers/seed";
import { domainRoutes } from "../../../src/modules/domains/domain.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const h = vi.hoisted(() => ({
  edge: vi.fn(),
  reapply: vi.fn(),
  overlay: vi.fn(),
  supports: true as boolean | undefined,
  effectiveTarget: "local",
}));
vi.mock("@repo/platform/engine/modules/projects/edge-config.service", () => ({
  readProjectEdgeConfig: h.edge,
}));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", async (original) => ({
  ...(await original<object>()),
  reapplyProjectLiveRoutes: h.reapply,
}));
vi.mock("@repo/platform/engine/modules/domains/routing-apply.service", async (original) => ({
  ...(await original<object>()),
  applyProjectRouting: h.overlay,
}));
vi.mock("@repo/platform/engine/lib/platform-config", async (original) => ({
  ...(await original<object>()),
  platform: () => ({ target: h.effectiveTarget, routing: { supportsDomainProxy: h.supports } }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<object>()),
  withDeploymentPlatform: async (_deployment: unknown, work: (value: unknown) => unknown) =>
    work({ routing: { supportsDomainProxy: h.supports }, effectiveTarget: h.effectiveTarget }),
}));
vi.mock("@repo/platform/engine/lib/self-app-routing", () => ({
  canRouteSelfApp: async () => false,
}));
const app = new Hono().onError(handleApiError).route("/api/domains", domainRoutes);
beforeEach(() => {
  vi.clearAllMocks();
  h.supports = true;
  h.effectiveTarget = "local";
  h.edge.mockResolvedValue({ reachable: true, proxyKind: "openresty", hosts: [] });
  h.reapply.mockResolvedValue(undefined);
  h.overlay.mockResolvedValue(undefined);
});
async function fixture() {
  const owner = await seedOwner();
  const project = await seedProject(owner.orgId);
  const domain = await repos.domain.create({
    projectId: project.id,
    hostname: `${project.id}.example.com`,
    domainType: "custom",
  });
  const patch = (body: unknown, auth = owner.auth) =>
    app.request(`/api/domains/${domain.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const deployment = await seedDeployment(project, { meta: { deployTarget: "local" } });
  await setActive(project.id, deployment.id);
  return { owner, project, domain, patch };
}

describe("PATCH /api/domains/:id", () => {
  it("authenticates and hides domains in other projects/organizations", async () => {
    const { domain, patch } = await fixture();
    const other = await seedOwner();
    expect((await patch({ proxy: null }, {})).status).toBe(401);
    expect((await patch({ proxy: null }, other.auth)).status).toBe(404);
    expect((await repos.domain.findById(domain.id))?.proxy).toBeNull();
    expect(h.reapply).not.toHaveBeenCalled();
  });
  it.each(["webhook", "mail"])(
    "rejects an imported hybrid %s row even when its project owner has write access",
    async (ownerType) => {
      const { project, domain, patch } = await fixture();
      await db
        .update(schema.domain)
        .set({ ownerType, proxy: { clientMaxBodySize: "1m" } })
        .where(eq(schema.domain.id, domain.id));
      const before = await repos.domain.findById(domain.id);
      expect(before).toMatchObject({ ownerType, projectId: project.id });
      for (const body of [
        { proxy: { clientMaxBodySize: "2m" } },
        { proxy: null },
        { proxy: {} },
        {},
      ]) {
        expect((await patch(body)).status).toBe(404);
        expect(await repos.domain.findById(domain.id)).toEqual(before);
      }
      expect(h.edge).not.toHaveBeenCalled();
      expect(h.reapply).not.toHaveBeenCalled();
      expect(h.overlay).not.toHaveBeenCalled();
    },
  );
  it("requires write access to the owning project within the same organization", async () => {
    const { owner, project, patch } = await fixture();
    const other = await seedProject(owner.orgId);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, owner.userId));
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "project",
      resourceId: other.id,
      permissions: ["write"],
      grantedByUserId: null,
    });
    expect((await patch({ proxy: null })).status).toBe(404);
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "project",
      resourceId: project.id,
      permissions: ["read"],
      grantedByUserId: null,
    });
    expect((await patch({ proxy: null })).status).toBe(404);
    expect(h.reapply).not.toHaveBeenCalled();
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "project",
      resourceId: project.id,
      permissions: ["write"],
      grantedByUserId: null,
    });
    expect((await patch({ proxy: null })).status).toBe(200);
  });
  it("preserves zero, replaces with {}, omits unchanged, and clears with null", async () => {
    const { domain, patch } = await fixture();
    for (const proxy of [{ clientMaxBodySize: "0" }, {}, { clientMaxBodySize: "2m" }, null]) {
      const result = await patch({ proxy });
      expect(result.status).toBe(200);
      expect((await result.json()).data.proxy).toEqual(proxy);
      expect((await repos.domain.findById(domain.id))?.proxy).toEqual(proxy);
    }
    await patch({ proxy: { clientMaxBodySize: "3m" } });
    h.reapply.mockClear();
    expect((await patch({})).status).toBe(200);
    expect((await repos.domain.findById(domain.id))?.proxy).toEqual({ clientMaxBodySize: "3m" });
    expect(h.reapply).not.toHaveBeenCalled();
  });
  it.each([
    { proxy: { clientMaxBodySize: "2m;return 200" } },
    { proxy: { clientMaxBodySize: "2m\n" } },
    { proxy: { clientMaxBodySize: "999999999999999999999999999g" } },
    { proxy: { clientMaxBodySize: "25" } },
    { proxy: { proxyReadTimeout: "2s" } },
    { projectId: "another-project", proxy: null },
  ])("rejects malformed or out-of-scope updates %j", async (body) => {
    const { domain, patch } = await fixture();
    expect((await patch(body)).status).toBe(400);
    expect((await repos.domain.findById(domain.id))?.proxy).toBeNull();
    expect(h.reapply).not.toHaveBeenCalled();
  });
  it("rejects unsupported providers before saving", async () => {
    const { domain, patch } = await fixture();
    h.edge.mockResolvedValue({ reachable: true, proxyKind: "traefik", hosts: [] });
    const result = await patch({ proxy: { clientMaxBodySize: "2m" } });
    expect(result.status).toBe(501);
    expect((await result.json()).code).toBe("CAPABILITY_UNAVAILABLE");
    expect((await repos.domain.findById(domain.id))?.proxy).toBeNull();
  });
  it.each([false, undefined])(
    "rejects unsupported/noop provider capability %j before saving despite installed nginx",
    async (supports) => {
      const { domain, patch } = await fixture();
      h.supports = supports;
      const result = await patch({ proxy: { clientMaxBodySize: "2m" } });
      expect(result.status).toBe(501);
      expect((await result.json()).code).toBe("CAPABILITY_UNAVAILABLE");
      expect((await repos.domain.findById(domain.id))?.proxy).toBeNull();
      expect(h.edge).not.toHaveBeenCalled();
    },
  );
  it.each(["cloud", "cluster"])("rejects a resolved %s provider before saving", async (target) => {
    const { domain, patch } = await fixture();
    h.effectiveTarget = target;
    expect((await patch({ proxy: { clientMaxBodySize: "2m" } })).status).toBe(501);
    expect((await repos.domain.findById(domain.id))?.proxy).toBeNull();
  });
  it("can clear a legacy override on an unsupported provider without an applied claim", async () => {
    const { domain, patch } = await fixture();
    await repos.domain.update(domain.id, { proxy: { clientMaxBodySize: "2m" } });
    h.supports = false;
    const result = await patch({ proxy: null });
    expect(result.status).toBe(200);
    expect((await result.json()).data).toMatchObject({ proxy: null });
    expect((await repos.domain.findById(domain.id))?.proxy).toBeNull();
    expect(h.edge).not.toHaveBeenCalled();
  });
  it.each(["throw", "warning"])(
    "persists the active deployment routing warning after %s apply failure",
    async (failure) => {
      const { project, domain, patch } = await fixture();
      const active = await seedDeployment(project, {
        meta: { deployTarget: "local", preserved: "active-snapshot" },
      });
      await setActive(project.id, active.id);
      const unrelated = await seedDeployment(project, { meta: { preserved: "not-active" } });
      const message =
        failure === "throw" ? "nginx config validation failed" : "nginx reload failed";
      h.reapply.mockImplementation(async (_project, _hosts, options) => {
        if (failure === "throw") throw new Error(message);
        options.onWarning(message);
      });
      const result = await patch({ proxy: { clientMaxBodySize: "2m" } });
      expect(result.status).toBe(502);
      expect((await result.json()).code).toBe("DOMAIN_PROXY_APPLY_FAILED");
      // Independent reads model returning to the project after the request ends.
      const reloadedProject = (await repos.project.findById(project.id))!;
      const reloadedDeployment = await repos.deployment.findById(
        reloadedProject.activeDeploymentId!,
      );
      expect(reloadedDeployment).toMatchObject({
        status: active.status,
        meta: {
          preserved: "active-snapshot",
          edgeUnsynced: true,
          deployWarning: expect.stringContaining(message),
        },
      });
      expect((await repos.deployment.findById(unrelated.id))?.meta).toEqual({
        preserved: "not-active",
      });
      expect((await repos.domain.findById(domain.id))?.proxy).toEqual({ clientMaxBodySize: "2m" });
    },
  );
  it.each([null, {}])(
    "clearing a legacy override (%j) reports reconciliation failure separately and durably",
    async (proxy) => {
      const { project, domain, patch } = await fixture();
      const active = await seedDeployment(project, { meta: { deployTarget: "local" } });
      await setActive(project.id, active.id);
      await repos.domain.update(domain.id, { proxy: { clientMaxBodySize: "2m" } });
      h.supports = false;
      h.reapply.mockRejectedValue(new Error("legacy provider route reconciliation failed"));
      const result = await patch({ proxy });
      expect(result.status).toBe(502);
      expect((await result.json()).code).toBe("DOMAIN_PROXY_APPLY_FAILED");
      expect((await repos.domain.findById(domain.id))?.proxy).toEqual(proxy);
      expect((await repos.deployment.findById(active.id))?.meta).toMatchObject({
        edgeUnsynced: true,
        deployWarning: expect.stringContaining("legacy provider route reconciliation failed"),
      });
      expect(h.edge).not.toHaveBeenCalled();
    },
  );
  it.each(["none", "prior unrelated", "new unrelated"])(
    "successful repeat save resolves only its owned warning (%s)",
    async (previous) => {
      const { project, domain, patch } = await fixture();
      const current = (await repos.project.findById(project.id))!;
      const deployment = (await repos.deployment.findById(current.activeDeploymentId!))!;
      const baseline = {
        preserved: "metadata",
        ...(previous === "prior unrelated"
          ? { edgeUnsynced: true, deployWarning: "Unrelated certificate warning" }
          : {}),
      };
      await repos.deployment.updateStatus(deployment.id, deployment.status, {
        meta: { ...deployment.meta, ...baseline },
      });
      h.reapply.mockRejectedValueOnce(new Error("cap reload failed"));
      expect((await patch({ proxy: { clientMaxBodySize: "2m" } })).status).toBe(502);
      const failed = (await repos.deployment.findById(deployment.id))!;
      expect(failed.meta).toMatchObject({
        edgeUnsynced: true,
        deployWarning: expect.stringContaining("cap reload failed"),
      });
      if (previous === "new unrelated")
        await repos.deployment.updateStatus(deployment.id, deployment.status, {
          meta: { ...failed.meta, deployWarning: "New unrelated verification warning" },
        });
      expect((await patch({ proxy: { clientMaxBodySize: "2m" } })).status).toBe(200);
      const recovered = (await repos.deployment.findById(deployment.id))!;
      expect(recovered.status).toBe(deployment.status);
      expect(recovered.meta).toMatchObject({ preserved: "metadata" });
      if (previous === "none") {
        expect(recovered.meta).not.toHaveProperty("edgeUnsynced");
        expect(recovered.meta).not.toHaveProperty("deployWarning");
      } else
        expect(recovered.meta).toMatchObject({
          edgeUnsynced: true,
          deployWarning:
            previous === "prior unrelated"
              ? "Unrelated certificate warning"
              : "New unrelated verification warning",
        });
      expect((await repos.domain.findById(domain.id))?.proxy).toEqual({ clientMaxBodySize: "2m" });
    },
  );
  it("returns a failed apply error and keeps desired state available for routing retry", async () => {
    const { domain, patch } = await fixture();
    h.reapply.mockRejectedValue(new Error("nginx -t failed"));
    const result = await patch({ proxy: { clientMaxBodySize: "2m" } });
    expect(result.status).toBe(502);
    expect((await result.json()).code).toBe("DOMAIN_PROXY_APPLY_FAILED");
    expect((await repos.domain.findById(domain.id))?.proxy).toEqual({ clientMaxBodySize: "2m" });
    await flushAudit();
    const failedAudit = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.resourceId, domain.id));
    expect(failedAudit).toContainEqual(
      expect.objectContaining({
        eventType: "domain:write",
        after: expect.objectContaining({ operation: "update", failed: true }),
      }),
    );
    h.reapply.mockResolvedValue(undefined);
    expect((await patch({ proxy: { clientMaxBodySize: "2m" } })).status).toBe(200);
    await flushAudit();
    const savedAudit = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.resourceId, domain.id));
    expect(savedAudit).toContainEqual(
      expect.objectContaining({
        eventType: "domain:write",
        after: expect.objectContaining({ operation: "update", proxy: { clientMaxBodySize: "2m" } }),
      }),
    );
  });
});
