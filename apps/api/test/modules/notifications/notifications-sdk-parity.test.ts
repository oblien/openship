import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { seedOwner, installFakeRunner, db, schema, repos, type SeededOwner } from "../jobs/_harness";
import { eq, sql } from "@repo/db";
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

const h = vi.hoisted(() => ({ fetch: vi.fn(), mail: vi.fn() }));
// All provider sends are local fakes. Exercise retained rendering, signing,
// response handling and authorization without sending any external messages.
vi.mock("@repo/platform/engine/lib/safe-fetch", async original => ({ ...await original<object>(), safeFetch: h.fetch }));
vi.mock("@repo/platform/engine/lib/mail", async original => ({ ...await original<object>(), sendMail: h.mail }));

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/notifications", notificationsRoutes);
beforeEach(async () => {
  await stopNotificationRunner();
  await db.delete(schema.notificationDelivery);
  h.fetch.mockReset().mockImplementation(async () => new Response("{}"));
  h.mail.mockReset().mockResolvedValue(true);
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
  it("paginates visible history across hidden rows without shifting on inserts or crossing scopes", async () => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner);
    const visible = await project(owner, "history-visible"), hidden = await project(owner, "history-hidden");
    const base = { userId: owner.userId, organizationId: owner.orgId, channelKind: "in_app", category: "deploy.failed" };
    await db.insert(schema.notificationDelivery).values([
      ...Array.from({ length: 260 }, (_, index) => ({ ...base, id: `history-hidden-${String(index).padStart(3, "0")}`, payload: { resourceType: "project", resourceId: hidden.id } })),
      ...["a", "b", "c"].map(id => ({ ...base, id: `history-${id}`, payload: { resourceType: "project", resourceId: visible.id } })),
      { ...base, id: "foreign-user", userId: other.userId, payload: {} },
      { ...base, id: "foreign-org", organizationId: other.orgId, payload: {} },
    ]);
    // Equal sub-millisecond timestamps exercise the ID tie-break without rounding
    // the database cursor through JavaScript Date serialization.
    await db.update(schema.notificationDelivery).set({ createdAt: sql`'2026-10-23 12:34:56.123456'::timestamp` });
    await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
    for (const [resourceType, resourceId, permissions] of [["notifications", "*", ["read"]], ["project", visible.id, ["read"]]] as const)
      await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType, resourceId, permissions: [...permissions], grantedByUserId: owner.userId });

    for (const client of [c.native, c.remote]) {
      const first = await client.listDeliveries({ limit: 2 });
      expect(first.map(row => row.id)).toEqual(["history-c", "history-b"]);
      expect((await client.listDeliveries({ limit: 2, before: first.at(-1)!.id })).map(row => row.id)).toEqual(["history-a"]);
      for (const before of ["foreign-user", "foreign-org", "missing", "history-a"])
        expect(await client.listDeliveries({ limit: 2, before })).toEqual([]);
    }
    await db.insert(schema.notificationDelivery).values({ ...base, id: "newest", createdAt: new Date("2026-10-24"), payload: { resourceType: "project", resourceId: visible.id } });
    expect((await c.remote.listDeliveries({ limit: 2, before: "history-b" })).map(row => row.id)).toEqual(["history-a"]);
    expect((await c.native.listDeliveries({ limit: 2 })).map(row => row.id)).toEqual(["newest", "history-c"]);
    expect((await repos.notificationDelivery.findById("history-a"))?.seenAt).toBeNull();
    for (const client of [c.native, c.remote])
      await expect(client.listDeliveries({ before: "x".repeat(129) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: owner.userId, resourceType: "project", resourceId: visible.id, permissions: [], grantedByUserId: owner.userId });
    expect(await c.remote.listDeliveries({ before: "history-b" })).toEqual([]);
  });

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

  it("retries durable credit emails beyond ordinary limits and keeps the organization and delivery identity", async () => {
    const owner = await seedOwner();
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, owner.userId));
    const prepared = await notification.prepare({
      organizationId: owner.orgId, eventType: "billing.credit_low", resourceType: "billing",
      idempotencyKey: "quota-source-event", payload: { durable: true, message: "95% used", url: `https://dashboard.test/cloud-billing?organizationId=${owner.orgId}` },
    });
    await prepared(db);
    const queued = await repos.notificationDelivery.listForUser(owner.userId, owner.orgId);
    expect(queued.map(row => row.channelKind).sort()).toEqual(["email", "in_app"]);
    const email = queued.find(row => row.channelKind === "email")!;
    await db.update(schema.notificationDelivery).set({ attempts: 8 }).where(eq(schema.notificationDelivery.id, email.id));
    h.mail.mockResolvedValue(false);
    await processQueuedNotifications();
    expect((await repos.notificationDelivery.findById(email.id))?.status).toBe("queued");
    expect((await repos.notificationDelivery.findById(email.id))?.attempts).toBe(9);
    expect(h.mail).toHaveBeenCalledOnce();
    await processQueuedNotifications();
    expect(h.mail).toHaveBeenCalledOnce(); // Persisted backoff also applies to new worker ticks.
    h.mail.mockResolvedValue(true);
    await db.update(schema.notificationDelivery).set({ nextAttemptAt: new Date(0) }).where(eq(schema.notificationDelivery.id, email.id));
    await processQueuedNotifications();
    expect((await repos.notificationDelivery.findById(email.id))?.status).toBe("sent");
    expect(h.mail).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: owner.orgId, text: expect.stringContaining(owner.orgId) }));
    expect(await repos.notificationDelivery.listForUser(owner.userId, owner.orgId)).toHaveLength(2);
    const c = await clients(owner);
    expect(await c.native.testChannel(email.channelId!)).toMatchObject({ ok: true });
  });

  it("reuses Settings destinations and sends one credit email when the source event is retried", async () => {
    const owner = await seedOwner();
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, owner.userId));
    const user = (await repos.user.findById(owner.userId))!;
    const email = await repos.notificationChannel.create({
      userId: owner.userId, kind: "email", label: "My email", config: { address: user.email },
      verified: true, enabled: true,
    });
    const inbox = await repos.notificationChannel.create({
      userId: owner.userId, kind: "in_app", label: "My inbox", config: {}, verified: true, enabled: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const enqueue = await notification.prepare({
        organizationId: owner.orgId, eventType: "billing.credit_low", resourceType: "billing",
        idempotencyKey: "same-credit-warning", payload: { durable: true, message: "95% used" },
      });
      await enqueue(db);
    }
    const deliveries = await repos.notificationDelivery.listForUser(owner.userId, owner.orgId);
    expect(deliveries.map(row => row.channelId).sort()).toEqual([email.id, inbox.id].sort());
    await processQueuedNotifications();
    expect(h.mail).toHaveBeenCalledOnce();
    expect(h.mail).toHaveBeenCalledWith(expect.objectContaining({ to: user.email, organizationId: owner.orgId }));
  });

  it("never sends queued credit email after the account address or billing permission is revoked", async () => {
    const owner = await seedOwner();
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, owner.userId));
    const prepare = () => notification.prepare({ organizationId: owner.orgId, eventType: "billing.credit_exhausted", resourceType: "billing", idempotencyKey: "revoked-email", payload: { durable: true } });
    await (await prepare())(db);
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, owner.userId));
    await processQueuedNotifications();
    const email = (await repos.notificationDelivery.listForUser(owner.userId, owner.orgId)).find(row => row.channelKind === "email")!;
    expect(email.status).toBe("failed");
    expect(h.mail).not.toHaveBeenCalled();
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, owner.userId));
    await db.update(schema.notificationDelivery).set({ status: "queued", nextAttemptAt: new Date(0) }).where(eq(schema.notificationDelivery.id, email.id));
    await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
    await processQueuedNotifications();
    expect((await repos.notificationDelivery.findById(email.id))?.status).toBe("failed");
    expect(h.mail).not.toHaveBeenCalled();
  });
});
