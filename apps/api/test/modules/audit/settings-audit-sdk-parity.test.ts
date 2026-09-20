import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { seedOwner, seedServer, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { settingsRoutes } from "../../../src/modules/settings/settings.routes";
import { auditRoutes } from "../../../src/modules/audit/audit.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/settings", settingsRoutes).route("/api/audit", auditRoutes);
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "settings-test" }) } });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  return { native, remote };
}

describe("settings and audit shared SDK/HTTP operations", () => {
  it("uses the same stored preferences and keeps clone credentials out of results and audits", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    expect(await c.native.settings.get()).toEqual(await c.remote.settings.get());
    await c.remote.settings.setBuildMode({ buildMode: "server" });
    await c.native.settings.setRouteStrategy({ routeStrategy: "loopback-port" });
    await c.remote.settings.setGitForwarding({ enabled: true });
    await c.native.settings.setTransferPreferences({ transferMode: "rsync", transferCompression: "gzip" });
    await c.remote.settings.setCloneCredentials({ token: "private-clone-token", asDefault: true });
    await c.native.settings.setCloneStrategy({ preference: "remote-with-token" });
    const state = await c.native.settings.get();
    expect(state).toEqual(await c.remote.settings.get());
    expect(state).toMatchObject({ buildMode: "server", routeStrategy: "loopback-port", forwardGitToServer: true, cloneToken: { hasToken: true, asDefault: true }, transferMode: "rsync" });
    expect(decrypt((await repos.settings.findByUser(owner.userId))!.cloneTokenEncrypted!)).toBe("private-clone-token");
    await flushAudit();
    const audit = await c.native.audit.list();
    expect(audit).toEqual(await c.remote.audit.list());
    expect(audit.items).toHaveLength(6);
    expect(JSON.stringify([audit, state])).not.toContain("private-clone-token");
    await c.native.settings.setCloneCredentials({ token: null });
    expect((await c.remote.settings.get()).cloneToken).toMatchObject({ hasToken: false, asDefault: false });
  });

  it("checks and filters default-server references in the selected tenant", async () => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner);
    const own = await seedServer(owner.orgId), foreign = await seedServer(other.orgId);
    await c.remote.settings.setDeployDefaults({ defaultDeployTarget: "server", defaultServerId: own });
    expect((await c.native.settings.get()).defaultServerId).toBe(own);
    for (const client of [c.native.settings, c.remote.settings])
      await expect(client.setDeployDefaults({ defaultDeployTarget: "server", defaultServerId: foreign })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await repos.settings.update(owner.userId, { defaultServerId: foreign });
    expect(await c.native.settings.get()).toMatchObject({ defaultServerId: null, defaultDeployTarget: null });
    const otherClient = await clients(other);
    expect((await otherClient.native.settings.get()).cloneToken.hasToken).toBe(false);
  });

  it("shares cursor paging, facets and audit recording order across the interfaces", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    await c.native.settings.setBuildMode({ buildMode: "local" });
    await flushAudit();
    await c.remote.audit.updateSettings({ enabled: false, retentionDays: 30 });
    await c.native.settings.setBuildMode({ buildMode: "server" });
    await flushAudit();
    await c.native.audit.updateSettings({ enabled: true });
    const events = (await c.remote.audit.list()).items;
    expect(events.filter(row => row.eventType === "settings.updated")).toHaveLength(1);
    expect(events.map(row => row.eventType)).toContain("audit.disabled");
    expect(events.map(row => row.eventType)).toContain("audit.retention_changed");
    expect(events[0]?.eventType).toBe("audit.enabled");
    const first = await c.native.audit.list({ cursor: "", limit: 2 });
    expect(first).toEqual(await c.remote.audit.list({ cursor: "", limit: 2 }));
    if (!("pageInfo" in first)) throw new Error("Expected cursor paging");
    const next = await c.remote.audit.list({ cursor: first.pageInfo.endCursor!, limit: 2 });
    expect(next.items.some(row => first.items.some(item => item.id === row.id))).toBe(false);
    expect(await c.native.audit.facets()).toEqual(await c.remote.audit.facets());
    expect(await c.remote.audit.getSettings()).toEqual({ enabled: true, retentionDays: 30, canManage: true });
  });

  it("revalidates audit authority and refuses untyped invalid preference changes", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    for (const client of [c.native, c.remote]) {
      await expect(client.settings.setBuildMode({ buildMode: "unknown" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(client.audit.list({ limit: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, owner.userId));
    for (const client of [c.native.audit, c.remote.audit]) {
      await expect(client.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.updateSettings({ enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
