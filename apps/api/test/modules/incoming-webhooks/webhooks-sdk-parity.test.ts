import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { seedOwner, seedServer, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { createHook, updateHook } from "@repo/platform/engine/modules/incoming-webhooks/incoming.service";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { settingsRoutes } from "../../../src/modules/settings/settings.routes";
import { webhookRoutes } from "../../../src/modules/webhooks/webhook.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const external = vi.hoisted(() => ({ deploy: vi.fn(), runJob: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async original => ({
  ...await original<object>(), triggerDeployment: external.deploy,
}));
vi.mock("@repo/platform/engine/modules/jobs/job.service", async original => ({
  ...await original<object>(), runJobNow: external.runJob,
}));
installFakeRunner();
// app.request has no TCP peer; supply the trusted peer value that the real
// application resolves before rate limiting, while retaining ingress policy.
const app = new Hono().onError(handleApiError).use("*", async (c, next) => { c.set("clientIp", "192.0.2.123"); await next(); }).route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes).route("/api/settings", settingsRoutes).route("/api/webhooks", webhookRoutes);
beforeEach(() => {
  external.deploy.mockReset().mockResolvedValue({ deployment: { id: "deployed" } });
  external.runJob.mockReset().mockResolvedValue({ runId: "job-run" });
});
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "webhook-test" }) } });
  return {
    native: await ship.scope({ identity: "verified", organizationId: owner.orgId }),
    remote: new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch }),
  };
}
async function project(owner: SeededOwner, name: string) {
  const input = { organizationId: owner.orgId, name, slug: `${owner.userId}-${name}`, gitProvider: "upload" };
  const group = await repos.projectGroup.create(input);
  return repos.project.create({ ...input, groupId: group.id });
}
const fire = (id: string, token: string) => app.request(`/api/webhooks/incoming/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
async function restrict(owner: SeededOwner) {
  await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
}
async function grant(owner: SeededOwner, resourceType: "project" | "job" | "settings", resourceId: string, permissions: ("read" | "write" | "create")[]) {
  await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType, resourceId, permissions, grantedByUserId: owner.userId });
}

describe("incoming webhooks share management, dispatch and authority across SDK/HTTP", () => {
  it("retains encrypted credentials, CRUD semantics and one audit per management operation", async () => {
    const owner = await seedOwner(), p = await project(owner, "crud"), c = await clients(owner);
    const created = await c.native.webhooks.create(p.id, { actionType: "deploy", name: "Build" });
    expect(created).toMatchObject({ name: "Build", authMode: "token", requiresReauthorization: false, secret: expect.any(String) });
    const row = (await repos.incomingWebhook.findById(created.id))!;
    expect(row.tokenEncrypted).not.toBe(created.secret);
    expect(decrypt(row.tokenEncrypted!)).toBe(created.secret);
    expect(row.executionAuthority).toMatchObject({ userId: owner.userId, organizationId: owner.orgId, token: null });
    expect(await c.native.webhooks.list(p.id)).toEqual(await c.remote.webhooks.list(p.id));
    const updated = await c.remote.webhooks.update(p.id, created.id, { name: "Renamed" });
    expect(updated.secret).toBe(created.secret);
    const rotated = await c.native.webhooks.rotate(p.id, created.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect((await c.remote.webhooks.list(p.id))[0]?.secret).toBe(rotated.secret);
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, p.id));
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(created.secret!);
    await c.remote.webhooks.remove(p.id, created.id);
    expect(await c.native.webhooks.list(p.id)).toEqual([]);
  });

  it("masks secrets for readers and rejects forged parent/child pairs", async () => {
    const owner = await seedOwner(), p = await project(owner, "reader"), other = await project(owner, "other"), c = await clients(owner);
    const hook = await c.native.webhooks.create(p.id, { actionType: "deploy" });
    await restrict(owner);
    await grant(owner, "project", p.id, ["read"]);
    await grant(owner, "project", other.id, ["write"]);
    for (const client of [c.native.webhooks, c.remote.webhooks]) {
      expect((await client.list(p.id))[0]?.secret).toBeNull();
      await expect(client.rotate(p.id, hook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.rotate(other.id, hook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.hookDeliveries(other.id, hook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await repos.incomingWebhook.findById(hook.id))?.tokenEncrypted).toBeTruthy();
  });

  it("requires job and server authority to create, rearm or reveal job-trigger credentials", async () => {
    const owner = await seedOwner(), p = await project(owner, "job"), c = await clients(owner);
    const serverId = await seedServer(owner.orgId);
    const job = await c.native.jobs.create({ label: "Target", command: "true", serverIds: [serverId], scheduleType: "manual" });
    const hook = await c.native.webhooks.create(p.id, { actionType: "job", actionConfig: { jobKey: job.key } });
    await restrict(owner);
    await grant(owner, "project", p.id, ["write"]);
    await grant(owner, "job", "*", ["write"]);
    for (const client of [c.native.webhooks, c.remote.webhooks]) {
      expect((await client.list(p.id))[0]?.secret).toBeNull();
      expect((await client.update(p.id, hook.id, { name: "Still masked" })).secret).toBeNull();
      await expect(client.rotate(p.id, hook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.update(p.id, hook.id, { enabled: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.invoke(p.id, hook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.create(p.id, { actionType: "job", authMode: "none", actionConfig: { jobKey: job.key } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const changed = await c.native.webhooks.update(p.id, hook.id, { actionType: "deploy" });
    expect(changed.actionConfig).toEqual({});
    expect(changed.secret).not.toBe(hook.secret);
    expect(external.runJob).not.toHaveBeenCalled();
  });

  it("revalidates the original token at dispatch and never substitutes the organization owner", async () => {
    const owner = await seedOwner(), p = await project(owner, "revoked"), c = await clients(owner);
    const hook = await c.remote.webhooks.create(p.id, { actionType: "deploy" });
    expect(await c.native.webhooks.invoke(p.id, hook.id)).toEqual({ action: "deploy", ref: "deployed" });
    expect(external.deploy.mock.calls[0]?.[0]).toMatchObject({ userId: owner.userId, organizationId: owner.orgId, principalKind: "pat", scopeMode: "fixed" });
    const token = (await repos.personalAccessToken.listByUser(owner.userId))[0]!;
    await repos.personalAccessToken.revoke(token.id, owner.userId);
    await expect(c.native.webhooks.invoke(p.id, hook.id)).rejects.toMatchObject({ statusCode: 401 });
    const denied = await fire(hook.id, hook.secret!);
    expect(denied.status, await denied.text()).toBe(404);
    expect(external.deploy).toHaveBeenCalledTimes(1);
  });

  it("requires reauthorization for legacy hooks and keeps HMAC verification at ingress", async () => {
    const owner = await seedOwner(), p = await project(owner, "legacy"), c = await clients(owner);
    const legacy = await createHook({ projectId: p.id, organizationId: owner.orgId, name: "Old", actionType: "deploy", actionConfig: {}, authMode: "token", createdBy: owner.userId });
    await expect(c.native.webhooks.invoke(p.id, legacy.id)).rejects.toMatchObject({ code: "ACTION_REAUTHORIZATION_REQUIRED" });
    expect((await fire(legacy.id, legacy.secret!)).status).toBe(404);
    const rearmed = await c.native.webhooks.update(p.id, legacy.id, { enabled: true });
    expect(rearmed.requiresReauthorization).toBe(false);
    expect(rearmed.secret).not.toBe(legacy.secret);
    expect((await fire(legacy.id, legacy.secret!)).status).toBe(404);
    expect((await fire(legacy.id, rearmed.secret!)).status).toBe(200);
    const signed = await c.remote.webhooks.update(p.id, legacy.id, { authMode: "hmac" });
    const payload = '{"build":1}';
    const signature = `sha256=${createHmac("sha256", signed.secret!).update(payload).digest("hex")}`;
    expect((await app.request(`/api/webhooks/incoming/${signed.id}`, { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body: payload })).status).toBe(200);
    expect((await app.request(`/api/webhooks/incoming/${signed.id}`, { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body: payload + " " })).status).toBe(404);
    await db.delete(schema.member).where(eq(schema.member.userId, owner.userId));
    expect((await app.request(`/api/webhooks/incoming/${signed.id}`, { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body: payload })).status).toBe(404);
    expect(external.deploy).toHaveBeenCalledTimes(2);
  });

  it("filters delivery feeds before paging and excludes unassigned events from restricted views", async () => {
    const owner = await seedOwner(), visible = await project(owner, "visible"), hidden = await project(owner, "hidden"), c = await clients(owner);
    for (let i = 0; i < 4; i++) for (const projectId of [visible.id, hidden.id, null])
      await repos.webhookDelivery.record({ organizationId: owner.orgId, projectId, source: "incoming", event: "deploy", outcome: "dispatched", summary: { index: i } });
    await restrict(owner);
    await grant(owner, "project", "*", ["create"]);
    await grant(owner, "project", visible.id, ["read"]);
    await grant(owner, "settings", "*", ["read"]);
    for (const client of [c.native.webhooks, c.remote.webhooks]) {
      const first = await client.listDeliveries({ limit: 2 });
      expect(first.deliveries).toHaveLength(2);
      const next = await client.listDeliveries({ limit: 2, cursor: first.nextCursor });
      expect(next.deliveries).toHaveLength(2);
      expect(next.nextCursor).toBeUndefined();
      expect([...first.deliveries, ...next.deliveries].every(row => row.projectId === visible.id)).toBe(true);
      await expect(client.deliveries(hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.listDeliveries({ limit: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("refuses a concurrent action change before disclosing or overwriting its credential", async () => {
    const owner = await seedOwner(), p = await project(owner, "concurrent"), c = await clients(owner);
    const hook = await c.native.webhooks.create(p.id, { actionType: "deploy" });
    const authorized = (await repos.incomingWebhook.findById(hook.id))!;
    await repos.incomingWebhook.update(hook.id, { authMode: "hmac", tokenEncrypted: null });
    await expect(updateHook(p.id, hook.id, { name: "Stale" }, true, authorized)).rejects.toMatchObject({ statusCode: 409 });
    expect((await repos.incomingWebhook.findById(hook.id))?.name).toBe("Webhook");
  });
});
