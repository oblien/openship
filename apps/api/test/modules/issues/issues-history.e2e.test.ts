import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@repo/db";
import { initPlatform, resetPlatform } from "@repo/adapters";
import { OpenshipClient } from "@repo/sdk/client";
import { createShip } from "@repo/sdk/native";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { env } from "@repo/platform/engine/config/env";
import {
  makeApp,
  seedOwner,
  seedServer,
  db,
  schema,
  repos,
  type SeededOwner,
} from "../jobs/_harness";
import { issuesRoutes } from "../../../src/modules/issues/issues.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";

const app = makeApp().route("/api/health", healthRoutes).route("/api/issues", issuesRoutes);
beforeAll(() => initPlatform({ target: "desktop", runtime: "bare" }));
afterAll(() => resetPlatform());

async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const native = await createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "history-test",
        credential: { organizationId: owner.orgId, readOnly: false },
      }),
    },
  }).scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  return { native: native.issues, remote: remote.issues };
}
async function incident(owner: SeededOwner, serverId: string, resolved: boolean) {
  const row = (await repos.serviceIncident.open({
    organizationId: owner.orgId,
    serverId,
    projectId: null,
    serviceKey: `server:${serverId}`,
    serviceName: "server",
    kind: "server_unreachable",
  }))!;
  if (resolved) await repos.serviceIncident.resolve(row.id, new Date(Date.now() - 1000));
  return row;
}

describe("resolved monitoring history through the shared operation", () => {
  it("clears only resolved rows in the caller's org through HTTP and native SDK and retains the audit", async () => {
    const alice = await seedOwner(),
      bob = await seedOwner();
    const aServer = await seedServer(alice.orgId),
      bServer = await seedServer(bob.orgId);
    const old = await incident(alice, aServer, true);
    const active = await incident(alice, aServer, false);
    const foreign = await incident(bob, bServer, true);
    const a = await clients(alice);
    expect((await a.remote.list({ status: "resolved" })).canClearHistory).toBe(true);
    expect(await a.remote.clearHistory()).toEqual({ deleted: 1 });
    expect((await repos.serviceIncident.listByOrg(alice.orgId)).map((row) => row.id)).toEqual([
      active.id,
    ]);
    expect((await repos.serviceIncident.listByOrg(bob.orgId)).map((row) => row.id)).toEqual([
      foreign.id,
    ]);
    expect(await a.native.clearHistory()).toEqual({ deleted: 0 });
    await flushAudit();
    const events = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.organizationId, alice.orgId));
    expect(events.filter((event) => event.eventType === "issues.history.clear")).toHaveLength(2);
    expect(
      (await a.remote.list({ status: "resolved" })).issues.some((row) => row.id === old.id),
    ).toBe(false);
    const response = await app.request("/api/issues/history", {
      method: "DELETE",
      headers: { ...alice.auth, "X-Organization-Id": bob.orgId },
    });
    expect([403, 404]).toContain(response.status);
    expect((await repos.serviceIncident.listByOrg(bob.orgId))[0]?.id).toBe(foreign.id);
  });

  it("rejects members even with a wildcard project grant, without removing history", async () => {
    const actor = await seedOwner();
    const server = await seedServer(actor.orgId);
    const row = await incident(actor, server, true);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, actor.userId));
    await repos.resourceGrant.upsert({
      organizationId: actor.orgId,
      userId: actor.userId,
      resourceType: "project",
      resourceId: "*",
      permissions: ["admin"],
      grantedByUserId: null,
    });
    const a = await clients(actor);
    expect((await a.remote.list()).canClearHistory).toBe(false);
    for (const client of [a.remote, a.native])
      await expect(client.clearHistory()).rejects.toMatchObject({
        code: "MONITORING_HISTORY_ADMIN_REQUIRED",
      });
    expect((await repos.serviceIncident.listByOrg(actor.orgId))[0]?.id).toBe(row.id);
  });

  it("refuses unauthenticated and read-only requests", async () => {
    expect((await app.request("/api/issues/history", { method: "DELETE" })).status).toBe(401);
    const owner = await seedOwner();
    const server = await seedServer(owner.orgId);
    const row = await incident(owner, server, true);
    await db
      .update(schema.personalAccessToken)
      .set({ readOnly: true })
      .where(eq(schema.personalAccessToken.userId, owner.userId));
    const response = await app.request("/api/issues/history", {
      method: "DELETE",
      headers: owner.auth,
    });
    expect([403, 404]).toContain(response.status);
    expect((await repos.serviceIncident.listByOrg(owner.orgId))[0]?.id).toBe(row.id);
  });

  it("does not allow Cloud history deletion through HTTP or the native SDK", async () => {
    const owner = await seedOwner();
    const server = await seedServer(owner.orgId);
    const row = await incident(owner, server, true);
    const a = await clients(owner);
    const before = env.CLOUD_MODE;
    env.CLOUD_MODE = true;
    try {
      const response = await app.request("/api/issues/history", {
        method: "DELETE",
        headers: owner.auth,
      });
      expect(response.status).toBe(404);
      await expect(a.native.clearHistory()).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
      });
      expect((await repos.serviceIncident.listByOrg(owner.orgId))[0]?.id).toBe(row.id);
    } finally {
      env.CLOUD_MODE = before;
    }
  });

  it("rejects a scoped owner token even with wildcard administrative project access", async () => {
    const owner = await seedOwner();
    const server = await seedServer(owner.orgId);
    const row = await incident(owner, server, true);
    const [token] = await db
      .update(schema.personalAccessToken)
      .set({ scoped: true })
      .where(eq(schema.personalAccessToken.userId, owner.userId))
      .returning();
    await repos.patGrant.createMany(token!.id, [
      {
        resourceType: "project",
        resourceId: "*",
        permissions: ["admin"],
      },
    ]);
    const a = await clients(owner);
    expect((await a.remote.list()).canClearHistory).toBe(false);
    await expect(a.remote.clearHistory()).rejects.toMatchObject({
      code: "MONITORING_HISTORY_ADMIN_REQUIRED",
    });
    expect((await repos.serviceIncident.listByOrg(owner.orgId))[0]?.id).toBe(row.id);
  });
});
