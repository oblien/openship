import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createNotificationChannelRepo, createNotificationDeliveryRepo } from "./notification.repo";
import { createAuditEventRepo } from "./audit-event.repo";
import { createAuditSettingsRepo } from "./audit-settings.repo";
import type { Database } from "../client";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const delivery = createNotificationDeliveryRepo(db);
const channels = createNotificationChannelRepo(db);
const data = {
  userId: "u1",
  organizationId: "org1",
  channelId: "ch1",
  channelKind: "email",
  category: "quota.warning",
  payload: { durable: true },
};
beforeAll(async () => {
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../../drizzle") });
  await client.exec("SET session_replication_role = replica");
});
beforeEach(async () => {
  await client.exec(
    'TRUNCATE notification_delivery, notification_channel, oblien_webhook_event, audit_event, "user" CASCADE',
  );
});
afterAll(async () => {
  await client.close();
});

describe("durable credit notifications with real Postgres semantics", () => {
  it("rolls back recipient fan-out, exhaustion activity, and the checkpoint, and deduplicates retries", async () => {
    await expect(
      db.transaction(async (tx) => {
        await createNotificationDeliveryRepo(tx as unknown as Database).createOnce("evt1", data);
        await createAuditEventRepo(tx as unknown as Database, createAuditSettingsRepo(tx as unknown as Database)).create({
          organizationId: data.organizationId, eventType: "billing.credit_exhausted", source: "webhook",
        });
        await tx
          .insert(schema.oblienWebhookEvent)
          .values({
            oblienEventId: "evt1",
            eventType: "credits.depleted",
            processedAt: new Date(),
          });
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");
    expect(await db.select().from(schema.notificationDelivery)).toHaveLength(0);
    expect(await db.select().from(schema.oblienWebhookEvent)).toHaveLength(0);
    expect(await db.select().from(schema.auditEvent)).toHaveLength(0);
    await Promise.all(Array.from({ length: 10 }, () => delivery.createOnce("evt1", data)));
    await delivery.createOnce("evt1", { ...data, organizationId: "org2" });
    await delivery.createOnce("evt1", { ...data, userId: "u2" });
    expect(await db.select().from(schema.notificationDelivery)).toHaveLength(3);
  });
  it("keeps stable IDs after process interruption and persists backoff beyond a worker restart", async () => {
    await delivery.createOnce("evt1", data);
    const [claimed] = await delivery.claimQueued();
    expect(claimed).toBeDefined();
    expect(await delivery.claimQueued()).toHaveLength(0);
    await delivery.failInterrupted("process restarted");
    const [reclaimed] = await delivery.claimQueued();
    expect(reclaimed.id).toBe(claimed.id);
    await delivery.markFailed(reclaimed.id, "SMTP unavailable", true);
    expect(await delivery.claimQueued()).toHaveLength(0);
    const [queued] = await db.select().from(schema.notificationDelivery);
    expect(queued.status).toBe("queued");
    expect(queued.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await client.exec(
      "UPDATE notification_delivery SET next_attempt_at = NOW() - INTERVAL '1 second'",
    );
    expect((await delivery.claimQueued())[0].id).toBe(claimed.id);
  });
  it("seeds only verified account email and preserves a disabled default channel", async () => {
    await db
      .insert(schema.user)
      .values({ id: "u1", email: "one@example.test", name: "One", emailVerified: false });
    await channels.ensureAccountChannels("u1");
    expect((await channels.listByUser("u1")).map((row) => row.kind)).toEqual(["in_app"]);
    await client.exec("UPDATE \"user\" SET email_verified = true WHERE id = 'u1'");
    await channels.ensureAccountChannels("u1");
    const email = (await channels.listByUser("u1")).find((row) => row.kind === "email")!;
    expect(email.config).toEqual({ address: "one@example.test", accountEmail: true });
    await channels.update(email.id, { enabled: false });
    await channels.ensureAccountChannels("u1");
    expect((await channels.findById(email.id))?.enabled).toBe(false);
    expect(await channels.listByUser("u1")).toHaveLength(2);
  });

  it.each([true, false])("keeps existing account destinations and their enabled=%s preference", async (enabled) => {
    await db.insert(schema.user).values({
      id: "u1", email: "one@example.test", name: "One", emailVerified: true,
    });
    const email = await channels.create({
      userId: "u1", kind: "email", label: "My email", config: { address: "one@example.test" },
      verified: true, enabled,
    });
    const inbox = await channels.create({
      userId: "u1", kind: "in_app", label: "My inbox", config: {}, verified: true, enabled,
    });
    await Promise.all(Array.from({ length: 6 }, () => channels.ensureAccountChannels("u1")));
    const held = await channels.listByUser("u1");
    expect(held.map(row => row.id).sort()).toEqual([email.id, inbox.id].sort());
    expect(held.every(row => row.enabled === enabled)).toBe(true);
    expect(await channels.listVerifiedForUsersByKinds(["u1"], ["email", "in_app"]))
      .toHaveLength(enabled ? 2 : 0);
  });

  it("recovers an expired claim without restarting and fences acknowledgments from the former worker", async () => {
    await delivery.createOnce("evt1", data);
    const [first] = await delivery.claimQueued();
    expect(await delivery.renewLease(first.id, first.attempts + 1)).toBe(true);
    expect(await delivery.claimQueued()).toHaveLength(0);
    await client.exec("UPDATE notification_delivery SET lease_until = NOW() - INTERVAL '1 second'");
    expect(await delivery.renewLease(first.id, first.attempts + 1)).toBe(false);
    const [second] = await delivery.claimQueued();
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(first.attempts + 1);
    await delivery.markSent(first.id, first.attempts + 1);
    await delivery.markFailed(first.id, "late failure from old worker", false, first.attempts + 1);
    expect((await delivery.findById(first.id))?.status).toBe("sending");
    await delivery.markSent(second.id, second.attempts + 1);
    expect((await delivery.findById(second.id))?.status).toBe("sent");
  });
});


describe("inbox acknowledgement preserves delivery progress", () => {
  it.each(["email", "in_app"])("keeps viewed queued %s notifications claimable", async channelKind => {
    const row = await delivery.create({ ...data, channelKind });
    await delivery.markSeen(row.id, data.userId, data.organizationId);
    expect(await delivery.findById(row.id)).toMatchObject({ status: "queued", seenAt: expect.any(Date), attempts: 0 });
    expect(await delivery.unseenCount(data.userId, data.organizationId)).toBe(0);
    expect(await delivery.listForUser(data.userId, data.organizationId, { unseenOnly: true })).toEqual([]);
    expect((await delivery.claimQueued()).map(item => item.id)).toEqual([row.id]);
    expect((await delivery.findById(row.id))?.status).toBe("sending");
  });

  it("preserves a sending worker's lease and successful acknowledgement after inbox viewing", async () => {
    const row = await delivery.create(data);
    const [claimed] = await delivery.claimQueued();
    const before = (await delivery.findById(row.id))!;
    await delivery.markSeen(row.id, data.userId, data.organizationId);
    const viewed = (await delivery.findById(row.id))!;
    expect(viewed).toMatchObject({ status: "sending", attempts: before.attempts, leaseUntil: before.leaseUntil, seenAt: expect.any(Date) });
    expect(await delivery.renewLease(row.id, claimed.attempts + 1)).toBe(true);
    await delivery.markSent(row.id, claimed.attempts + 1);
    expect(await delivery.findById(row.id)).toMatchObject({ status: "sent", sentAt: expect.any(Date), leaseUntil: null, seenAt: viewed.seenAt });
    expect(await delivery.unseenCount(data.userId, data.organizationId)).toBe(0);
  });

  it("allows a sending worker to record failure after inbox viewing", async () => {
    const row = await delivery.create(data);
    const [claimed] = await delivery.claimQueued();
    await delivery.markSeen(row.id, data.userId, data.organizationId);
    await delivery.markFailed(row.id, "SMTP rejected delivery", false, claimed.attempts + 1);
    expect(await delivery.findById(row.id)).toMatchObject({ status: "failed", lastError: "SMTP rejected delivery", leaseUntil: null, seenAt: expect.any(Date) });
  });

  it("retains a failed delivery's outcome and error when viewed", async () => {
    const row = await delivery.create({ ...data, status: "failed", lastError: "Destination unavailable", attempts: 3 });
    await delivery.markSeen(row.id, data.userId, data.organizationId);
    expect(await delivery.findById(row.id)).toMatchObject({ status: "failed", lastError: "Destination unavailable", attempts: 3, seenAt: expect.any(Date) });
    expect(await delivery.claimQueued()).toEqual([]);
    expect(await delivery.listForUser(data.userId, data.organizationId, { excludeFailed: true })).toEqual([]);
  });

  it.each(["email", "in_app"])("retains sent-to-seen compatibility for %s and is idempotent", async channelKind => {
    const sentAt = new Date("2026-01-01T00:00:00Z");
    const row = await delivery.create({ ...data, channelKind, status: "sent", sentAt });
    await delivery.markSeen(row.id, data.userId, data.organizationId);
    const seen = (await delivery.findById(row.id))!;
    expect(seen).toMatchObject({ status: "seen", sentAt, seenAt: expect.any(Date) });
    // Fix the first-view clock well in the past so resetting it cannot pass by
    // coincidence when two calls happen during the same millisecond.
    const historical = await delivery.create({ ...data, status: "seen", seenAt: sentAt });
    await delivery.markSeen(historical.id, data.userId, data.organizationId);
    expect(await delivery.findById(historical.id)).toEqual(historical);
    await delivery.markSeen(row.id, data.userId, data.organizationId);
    expect(await delivery.findById(row.id)).toEqual(seen);
  });

  it("retains both recipient and organization boundaries", async () => {
    const own = await delivery.create(data);
    const otherUser = await delivery.create({ ...data, userId: "u2" });
    const otherOrg = await delivery.create({ ...data, organizationId: "org2" });
    await delivery.markSeen(otherUser.id, data.userId, data.organizationId);
    await delivery.markSeen(otherOrg.id, data.userId, data.organizationId);
    await delivery.markSeen(own.id, "u2", data.organizationId);
    await delivery.markSeen(own.id, data.userId, "org2");
    await delivery.markSeen("missing", data.userId, data.organizationId);
    expect(await delivery.findById(own.id)).toEqual(own);
    expect(await delivery.findById(otherUser.id)).toEqual(otherUser);
    expect(await delivery.findById(otherOrg.id)).toEqual(otherOrg);
    await delivery.markSeen(own.id, data.userId, data.organizationId);
    expect(await delivery.unseenCount(data.userId, data.organizationId)).toBe(0);
    expect(await delivery.unseenCount("u2", data.organizationId)).toBe(1);
    expect(await delivery.unseenCount(data.userId, "org2")).toBe(1);
  });
});
