import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { seedOwner, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { notification } from "@repo/platform/engine/lib/notification-dispatcher";
import { processQueuedNotifications, stopNotificationRunner } from "@repo/platform/engine/lib/notification-workers";
import { notificationsRoutes } from "../../../src/modules/notifications/notifications.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
// All provider sends are local fakes. Exercise retained rendering, signing,
// response handling and authorization without sending any external messages.
vi.mock("@repo/platform/engine/lib/safe-fetch", async original => ({ ...await original<object>(), safeFetch: h.fetch }));

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/notifications", notificationsRoutes);
beforeEach(async () => {
  await stopNotificationRunner();
  await db.delete(schema.notificationDelivery);
  h.fetch.mockReset().mockImplementation(async () => new Response("{}"));
});
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "notification-test" }) } });
  const native = (await ship.scope({ identity: "verified", organizationId: owner.orgId })).notifications;
  const remote = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch }).notifications;
  return { native, remote };
}
async function project(owner: SeededOwner, name: string) {
  const input = { organizationId: owner.orgId, name, slug: `${owner.userId}-${name}`, gitProvider: "upload" };
  const group = await repos.projectGroup.create(input);
  return repos.project.create({ ...input, groupId: group.id });
}
async function delivery(owner: SeededOwner, channelId: string, projectId?: string, channelKind = "in_app") {
  return repos.notificationDelivery.create({ userId: owner.userId, organizationId: owner.orgId, category: "deploy.failed", channelId, channelKind, payload: projectId ? { resourceType: "project", resourceId: projectId, message: "Private build details" } : {} });
}

describe("notifications shared SDK/HTTP operations", () => {
  it("retains channel encryption, one-time reveal, verification and exactly one audit", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const created = await c.remote.createChannel({ kind: "webhook", label: "Receiver", config: { url: "https://receiver.example.test/notify" } });
    expect(created.secret).toEqual(expect.any(String));
    const stored = (await repos.notificationChannel.findById(created.channel.id))!;
    expect(decrypt((stored.config as { hmacSecret: string }).hmacSecret)).toBe(created.secret);
    expect(await c.native.listChannels()).toEqual(await c.remote.listChannels());
    expect(JSON.stringify(await c.native.listChannels())).not.toContain(created.secret!);
    const updated = await c.native.updateChannel(created.channel.id, { config: { url: "https://receiver.example.test/changed" } });
    expect(updated.secret).toBeUndefined();
    expect((await repos.notificationChannel.findById(created.channel.id))?.config).toMatchObject({ hmacSecret: (stored.config as object as { hmacSecret: string }).hmacSecret });
    expect(await c.remote.testChannel(created.channel.id)).toEqual({ ok: true, verified: true });
    await c.native.updateChannel(created.channel.id, { config: { url: "https://receiver.example.test/rotated", hmacSecret: "rotated-secret" } });
    expect((await c.native.listChannels())[0]?.verified).toBe(false);
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, created.channel.id));
    expect(events).toHaveLength(4);
    expect(events.every(row => row.actorUserId === owner.userId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("rotated-secret");
  });

  it("keeps Telegram credentials during a chat-only edit and ignores client-supplied verification", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const token = "123456:abcdefghijklmnopqrstuvwxyz123456";
    const { channel } = await c.native.createChannel({ kind: "telegram", label: "Bot", config: { botToken: token, chatId: "12345" } });
    const changed = await c.remote.updateChannel(channel.id, { config: { chatId: "-100123456" }, verified: true } as never);
    expect(changed.channel).toMatchObject({ verified: false, config: { botTokenConfigured: true, chatId: "-100123456" } });
    expect(decrypt(((await repos.notificationChannel.findById(channel.id))!.config as { botToken: string }).botToken)).toBe(token);
    expect(JSON.stringify(changed)).not.toContain(token);
  });

  it("keeps per-user channels and per-org subscriptions isolated, including idempotent deletes", async () => {
    const alice = await seedOwner(), bob = await seedOwner(), a = await clients(alice), b = await clients(bob);
    const { channel } = await a.native.createChannel({ kind: "in_app", label: "Inbox" });
    const sub = await a.remote.upsertSubscription({ category: "deploy.failed", channelId: channel.id, enabled: true });
    expect(await a.native.listSubscriptions()).toEqual([sub]);
    for (const client of [b.native, b.remote]) {
      expect(await client.listChannels()).toEqual([]);
      expect(await client.listSubscriptions()).toEqual([]);
      for (const call of [() => client.updateChannel(channel.id, { label: "Stolen" }), () => client.testChannel(channel.id), () => client.removeChannel(channel.id), () => client.upsertSubscription({ category: "deploy.failed", channelId: channel.id, enabled: true })])
        await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await client.removeSubscription(sub.id)).toEqual({ ok: true });
    }
    expect(await a.remote.listSubscriptions()).toEqual([sub]);
    await a.native.removeSubscription(sub.id);
    expect(await a.remote.listSubscriptions()).toEqual([]);
  });

  it("preserves defaults compatibility and prevents regular members from changing org policy", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const value = await c.remote.upsertDefault({ category: "deploy.failed", defaultEnabled: true, defaultChannelKind: "in_app" });
    expect(value.defaultChannelKinds).toEqual(["in_app"]);
    expect(await c.native.listDefaults()).toEqual([value]);
    expect(await c.native.categories()).toEqual(await c.remote.categories());
    await db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, owner.userId));
    for (const client of [c.native, c.remote]) await expect(client.upsertDefault({ category: "deploy.failed", defaultEnabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not verify a replacement configuration or hide normal delivery failures", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const { channel } = await c.native.createChannel({ kind: "webhook", label: "Receiver", config: { url: "https://receiver.example.test/old" } });
    let release!: (value: Response) => void;
    h.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const testing = c.native.testChannel(channel.id);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
    await c.remote.updateChannel(channel.id, { config: { url: "https://receiver.example.test/new" } });
    release(new Response("{}"));
    expect(await testing).toMatchObject({ ok: false });
    expect((await c.remote.listChannels())[0]?.verified).toBe(false);
    h.fetch.mockImplementation(async () => { throw new Error("Failed https://receiver.example.test/new"); });
    const result = await c.remote.testChannel(channel.id);
    expect(result).toEqual({ ok: false, error: "Failed <redacted>" });
  });

  it("filters the inbox and dispatch by current project grants and rechecks queued recipients", async () => {
    const owner = await seedOwner(), c = await clients(owner), visible = await project(owner, "visible"), hidden = await project(owner, "hidden");
    const { channel } = await c.native.createChannel({ kind: "in_app", label: "Inbox" });
    await c.native.upsertSubscription({ category: "deploy.failed", channelId: channel.id, enabled: true });
    const visibleDelivery = await delivery(owner, channel.id, visible.id), hiddenDelivery = await delivery(owner, channel.id, hidden.id);
    await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
    for (const [resourceType, resourceId, permissions] of [["notifications", "*", ["write"]], ["project", "*", ["create"]], ["project", visible.id, ["read"]]] as const)
      await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType, resourceId, permissions: [...permissions], grantedByUserId: owner.userId });
    for (const client of [c.native, c.remote]) {
      expect((await client.listDeliveries({ limit: 1 })).map(row => row.id)).toEqual([visibleDelivery.id]);
      expect(await client.unseenCount()).toBe(1);
    }
    await notification.emitSync({ organizationId: owner.orgId, eventType: "deployment.failed", resourceType: "project", resourceId: hidden.id, payload: { resourceType: "project", resourceId: visible.id } });
    expect(await repos.notificationDelivery.listForUser(owner.userId, owner.orgId)).toHaveLength(2);
    await processQueuedNotifications();
    expect((await repos.notificationDelivery.findById(visibleDelivery.id))?.status).toBe("sent");
    expect((await repos.notificationDelivery.findById(hiddenDelivery.id))?.status).toBe("failed");
    await c.remote.markSeen(visibleDelivery.id);
    expect(await c.native.unseenCount()).toBe(0);
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType: "project", resourceId: visible.id, permissions: [], grantedByUserId: owner.userId });
    expect(await c.native.listDeliveries()).toEqual([]);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("claims queued rows atomically and drains an accepted provider send before stopping", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    const { channel } = await c.native.createChannel({ kind: "webhook", label: "Receiver", config: { url: "https://receiver.example.test/notify" } });
    await c.native.testChannel(channel.id);
    const rows = await Promise.all([delivery(owner, channel.id, undefined, "webhook"), delivery(owner, channel.id, undefined, "webhook")]);
    const claims = await Promise.all([repos.notificationDelivery.claimQueued(1), repos.notificationDelivery.claimQueued(1)]);
    expect(new Set(claims.flat().map(row => row.id))).toEqual(new Set(rows.map(row => row.id)));
    await repos.notificationDelivery.failInterrupted("Previous worker interrupted");
    expect((await repos.notificationDelivery.findById(rows[0]!.id))?.status).toBe("failed");
    await db.delete(schema.notificationDelivery);
    const queued = await delivery(owner, channel.id, undefined, "webhook");
    let release!: (value: Response) => void;
    h.fetch.mockReset().mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    const first = processQueuedNotifications(), second = processQueuedNotifications();
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = stopNotificationRunner().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(new Response("{}"));
    await Promise.all([first, second, stopping]);
    expect((await repos.notificationDelivery.findById(queued.id))?.status).toBe("sent");
    expect((await repos.notificationDelivery.findById(queued.id))?.attempts).toBe(1);
  });
});
