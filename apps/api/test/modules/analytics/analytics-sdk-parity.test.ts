import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { seedOwner, seedServer, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { authorization } from "@repo/platform/engine/lib/authorization";
import { analyticsRoutes } from "../../../src/modules/analytics/analytics.routes";
import { issuesRoutes } from "../../../src/modules/issues/issues.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const h = vi.hoisted(() => ({ sample: vi.fn(), close: vi.fn(), pending: new Map(), snapshots: [] as object[], scan: vi.fn() }));
vi.mock("@repo/adapters", async original => ({ ...await original<object>(), getPlatform: () => ({ target: "desktop" }) }));
vi.mock("@repo/platform/engine/modules/monitoring/project-usage", async original => ({
  ...await original<object>(),
  openProjectUsageSampler: async () => ({ serverId: null, sample: h.sample, close: h.close }),
}));
vi.mock("@repo/platform/engine/modules/projects/pending-actions.service", async original => ({
  ...await original<object>(), getOrgPendingActions: async () => h.pending,
}));
vi.mock("@repo/platform/engine/modules/updates/updates.service", async original => ({
  ...await original<object>(), listOrganizationUpdates: async () => [],
}));
vi.mock("@repo/platform/engine/modules/monitoring/health-watch", async original => ({
  ...await original<object>(), listWorkloadHealthSnapshots: () => h.snapshots,
  getCurrentHealthScan: () => ({ completedAt: "2026-09-12T00:00:00.000Z", summary: { healthy: 2 } }),
  runCurrentHealthScan: h.scan,
}));

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/analytics", analyticsRoutes).route("/api/issues", issuesRoutes);
const usage = { supported: true, overall: { cpuPercent: 3, memoryMb: 10, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 }, services: [], capacity: { cpuCores: null, memoryMb: null }, timestamp: "2026-09-12T00:00:00.000Z" };
beforeEach(() => { h.pending.clear(); h.snapshots = []; h.sample.mockReset().mockResolvedValue(usage); h.close.mockReset().mockResolvedValue(undefined); h.scan.mockReset(); });

async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const identity = { user: { id: user.id, email: user.email, name: user.name }, sessionId: "analytics-test" };
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => identity } });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  return { native, remote, context: await authorization.resolveScope(identity, owner.orgId) };
}
async function project(owner: SeededOwner, name: string) {
  const input = { organizationId: owner.orgId, name, slug: `${owner.userId}-${name}`, gitProvider: "upload" };
  const group = await repos.projectGroup.create(input);
  return repos.project.create({ ...input, groupId: group.id });
}

describe("analytics and issues shared SDK/HTTP operations", () => {
  it("retains stored statistics, canonical results and one audit per collection change", async () => {
    const owner = await seedOwner(), p = await project(owner, "stats"), c = await clients(owner);
    await repos.deployment.create({ projectId: p.id, organizationId: owner.orgId, branch: "main", status: "ready" });
    for (const method of ["summary", "periods", "overview", "geo", "deploymentStats", "containerInfo"] as const)
      expect(await c.native.analytics[method](p.id)).toEqual(await c.remote.analytics[method](p.id));
    expect(await c.native.analytics.dashboard()).toEqual(await c.remote.analytics.dashboard());
    expect((await c.native.analytics.dashboard()).deployments).toMatchObject({ total: 1, success: 1 });
    expect(await c.remote.analytics.setPathsCollection(p.id, { enabled: true })).toEqual({ enabled: true });
    expect((await repos.project.findById(p.id))?.collectPaths).toBe(true);
    await c.native.analytics.setPathsCollection(p.id, { enabled: false });
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, p.id));
    expect(events).toHaveLength(2);
    expect(events.every(row => row.actorUserId === owner.userId)).toBe(true);
  });

  it("checks project access as well as analytics access and filters aggregate counts", async () => {
    const owner = await seedOwner(), p = await project(owner, "visible"), hidden = await project(owner, "hidden"), c = await clients(owner);
    await repos.deployment.create({ projectId: hidden.id, organizationId: owner.orgId, branch: "main", status: "failed" });
    await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
    for (const [resourceType, resourceId, permissions] of [["analytics", "*", ["read"]], ["project", "*", ["create"]], ["project", p.id, ["read"]]] as const)
      await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType, resourceId, permissions: [...permissions], grantedByUserId: owner.userId });
    for (const client of [c.native, c.remote]) {
      expect((await client.analytics.summary(p.id)).totalRequests).toBe(0);
      await expect(client.analytics.summary(hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.analytics.setPathsCollection(p.id, { enabled: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await client.analytics.dashboard()).toMatchObject({ projects: { total: 1 }, deployments: { total: 0, failed: 0 } });
    }
    const other = await seedOwner(), foreign = await project(other, "foreign");
    await expect(c.remote.analytics.summary(foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates bounded ranges and prevents reading another organization's server buckets", async () => {
    const owner = await seedOwner(), p = await project(owner, "ranges"), c = await clients(owner);
    const other = await seedOwner(), server = await seedServer(other.orgId);
    for (const client of [c.native.analytics, c.remote.analytics]) {
      for (const range of [{ from: "invalid" }, { from: "2026-09-12", to: "2026-09-11" }, { from: "1900-01-01", to: "2026-01-01" }])
        await expect(client.overview(p.id, range)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(client.serverBuckets(server, { domain: "private.example.test" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("filters issue rows before counts and withholds whole-org health scans from create-only grants", async () => {
    const owner = await seedOwner(), p = await project(owner, "visible"), hidden = await project(owner, "hidden"), c = await clients(owner);
    const pending = (id: string) => [{ id, kind: "domain_unverified", severity: "action_required", title: id, message: "Verify DNS", resolveWith: [] }];
    h.pending.set(p.id, pending("visible-issue")); h.pending.set(hidden.id, pending("hidden-issue"));
    const snapshot = (projectId: string) => ({ organizationId: owner.orgId, projectId, projectName: projectId, projectSlug: projectId, serviceId: null, serviceKey: "app", serviceName: "app", serverId: null, containerId: "container", state: "healthy", observedAt: "2026-09-12T00:00:00.000Z" });
    h.snapshots = [snapshot(p.id), snapshot(hidden.id)];
    await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType: "project", resourceId: "*", permissions: ["create"], grantedByUserId: owner.userId });
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType: "project", resourceId: p.id, permissions: ["read"], grantedByUserId: owner.userId });
    expect(await c.native.issues.list()).toEqual(await c.remote.issues.list());
    for (const client of [c.native.issues, c.remote.issues]) {
      const result = await client.list();
      expect(result.issues.map(row => row.title)).toEqual(["visible-issue"]);
      expect(await client.summary()).toMatchObject({ total: 1, actionRequired: 1 });
      const health = await client.health();
      expect(health.workloads.map(row => row.projectId)).toEqual([p.id]);
      expect(health.currentScan).toBeNull();
      await expect(client.scanHealth()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.scan).not.toHaveBeenCalled();
  });

  it("owns unopened sampler cleanup, rechecks stream access, and cancels a remote subscriber", async () => {
    const owner = await seedOwner(), p = await project(owner, "stream"), c = await clients(owner);
    const opened = await getPlatformKernel().analytics.openUsageStream(c.context, p.id);
    await opened.data[Symbol.asyncIterator]().return?.();
    expect(h.close).toHaveBeenCalledTimes(1);
    const stream = c.native.analytics.streamUsage(p.id)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toEqual({ event: "usage", data: JSON.stringify(usage) });
    await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
    await expect(stream.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.close).toHaveBeenCalledTimes(2);
    await db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.userId, owner.userId));
    const signal = new AbortController();
    const remote = c.remote.analytics.streamUsage(p.id, { signal: signal.signal })[Symbol.asyncIterator]();
    expect((await remote.next()).value?.event).toBe("usage");
    signal.abort();
    await remote.return?.();
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledTimes(3));
  });
});
