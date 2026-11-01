/**
 * Notification repos — channels, subscriptions, defaults, deliveries.
 *
 * Caller layering:
 *   - HTTP controllers (Settings UI)             → channel + subscription repos
 *   - Dispatcher (lib/notification-dispatcher)   → subscription lookup + delivery enqueue
 *   - Channel workers (lib/notification-workers) → delivery status updates
 *
 * Access scoping is enforced at the controller layer (every notification
 * is per-user); these repos take userId/organizationId as the canonical
 * filters and DO NOT cross-check membership themselves.
 */

import { createHash } from "node:crypto";
import { user } from "../schema/auth";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import {
  notificationChannel,
  notificationSubscription,
  notificationDefault,
  notificationDelivery,
} from "../schema/notification";

// ─── Types ───────────────────────────────────────────────────────────────────

export type NotificationChannel = typeof notificationChannel.$inferSelect;
export type NewNotificationChannel = typeof notificationChannel.$inferInsert;
export type NotificationSubscription = typeof notificationSubscription.$inferSelect;
export type NotificationDefault = typeof notificationDefault.$inferSelect;
export type NotificationDelivery = typeof notificationDelivery.$inferSelect;
export type NewNotificationDelivery = typeof notificationDelivery.$inferInsert;

export type ChannelKind =
  | "email"
  | "webhook"
  | "in_app"
  | "slack"
  | "discord"
  | "msteams"
  | "telegram";
export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "seen";

// ─── notification_channel repo ───────────────────────────────────────────────

export function createNotificationChannelRepo(db: Database) {
  return {
    /** Seed only authenticated account destinations; never re-enable an opt-out. */
    async ensureAccountChannels(userId: string): Promise<void> {
      const [account] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
      if (!account) return;
      const existing = await db.select().from(notificationChannel)
        .where(eq(notificationChannel.userId, userId));
      const key = (kind: string, address = "") => `nch_account_${kind}_${createHash("sha256").update(JSON.stringify([userId, address])).digest("hex")}`;
      // Settings channels may predate these deterministic defaults. Reuse their
      // destinations, including disabled/unverified rows, without changing the
      // user's verification or delivery preferences.
      const channels: NewNotificationChannel[] = [];
      if (!existing.some(channel => channel.kind === "in_app")) channels.push({
        id: key("in_app"), userId, kind: "in_app", label: "In-app", config: {}, verified: true, enabled: true,
      });
      const hasAccountEmail = existing.some(channel => {
        const address = (channel.config as { address?: unknown } | null)?.address;
        return channel.kind === "email" && typeof address === "string" &&
          address.trim().toLowerCase() === account.email.trim().toLowerCase();
      });
      if (account.emailVerified && account.email && !hasAccountEmail) channels.push({
        id: key("email", account.email), userId, kind: "email", label: "Account email",
        config: { address: account.email, accountEmail: true }, verified: true, enabled: true,
      });
      if (channels.length) await db.insert(notificationChannel).values(channels).onConflictDoNothing();
    },

    /** List channels for a user — newest first. Includes disabled rows
     *  so the Settings UI can show their enabled toggle. */
    async listByUser(userId: string): Promise<NotificationChannel[]> {
      return db
        .select()
        .from(notificationChannel)
        .where(eq(notificationChannel.userId, userId))
        .orderBy(desc(notificationChannel.createdAt));
    },

    async findById(id: string): Promise<NotificationChannel | undefined> {
      const [row] = await db
        .select()
        .from(notificationChannel)
        .where(eq(notificationChannel.id, id))
        .limit(1);
      return row;
    },

    /**
     * Find the first verified channel of a given kind for a user.
     * Used by the dispatcher when applying org defaults — if the user
     * has a verified email channel, use that; otherwise leave the
     * subscription channel-less (surfaces as "needs channel" in UI).
     */
    async findFirstVerifiedOfKind(
      userId: string,
      kind: ChannelKind,
    ): Promise<NotificationChannel | undefined> {
      const [row] = await db
        .select()
        .from(notificationChannel)
        .where(
          and(
            eq(notificationChannel.userId, userId),
            eq(notificationChannel.kind, kind),
            eq(notificationChannel.verified, true),
            eq(notificationChannel.enabled, true),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Batched dispatcher lookup for the org-default fallback: every enabled +
     * verified channel owned by any of `userIds` whose kind is in `kinds`.
     * One query instead of N×K `findFirstVerifiedOfKind` calls. Empty inputs
     * short-circuit to [].
     */
    async listVerifiedForUsersByKinds(
      userIds: string[],
      kinds: ChannelKind[],
    ): Promise<NotificationChannel[]> {
      if (userIds.length === 0 || kinds.length === 0) return [];
      return db
        .select()
        .from(notificationChannel)
        .where(
          and(
            inArray(notificationChannel.userId, userIds),
            inArray(notificationChannel.kind, kinds),
            eq(notificationChannel.verified, true),
            eq(notificationChannel.enabled, true),
          ),
        );
    },

    async create(
      data: Omit<NewNotificationChannel, "id" | "createdAt" | "updatedAt">,
    ): Promise<NotificationChannel> {
      const id = generateId("nch");
      const [row] = await db
        .insert(notificationChannel)
        .values({ id, ...data })
        .returning();
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewNotificationChannel, "id" | "userId" | "createdAt">>,
    ): Promise<NotificationChannel | undefined> {
      const [row] = await db
        .update(notificationChannel)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(notificationChannel.id, id))
        .returning();
      return row;
    },

    /** A test delivery only verifies the exact configuration that was tested. */
    async verifyIfUnchanged(expected: Pick<NotificationChannel, "id" | "userId" | "kind" | "config">): Promise<NotificationChannel | undefined> {
      const [row] = await db.update(notificationChannel).set({ verified: true, updatedAt: new Date() })
        .where(and(eq(notificationChannel.id, expected.id), eq(notificationChannel.userId, expected.userId), eq(notificationChannel.kind, expected.kind), eq(notificationChannel.config, expected.config))).returning();
      return row;
    },

    async delete(id: string): Promise<void> {
      await db.delete(notificationChannel).where(eq(notificationChannel.id, id));
    },

    /** Stamp lastDeliveredAt after a successful send. */
    async touchLastDelivered(id: string): Promise<void> {
      await db
        .update(notificationChannel)
        .set({ lastDeliveredAt: new Date() })
        .where(eq(notificationChannel.id, id));
    },
  };
}

// ─── notification_subscription repo ──────────────────────────────────────────

export function createNotificationSubscriptionRepo(db: Database) {
  return {
    async listForCategory(organizationId: string, category: string): Promise<NotificationSubscription[]> {
      return db.select().from(notificationSubscription).where(and(eq(notificationSubscription.organizationId, organizationId), eq(notificationSubscription.category, category)));
    },
    /** All subscriptions for a user in one org — drives the Settings UI table. */
    async listForUserInOrg(
      userId: string,
      organizationId: string,
    ): Promise<NotificationSubscription[]> {
      return db
        .select()
        .from(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.userId, userId),
            eq(notificationSubscription.organizationId, organizationId),
          ),
        );
    },

    /**
     * The dispatcher's hot-path lookup: every enabled subscription for
     * one (org, category) tuple. The indexed scan is bounded by org
     * membership, not by user count — even very large orgs land in
     * the low single-digit ms range.
     */
    async listEnabledForDispatch(
      organizationId: string,
      category: string,
    ): Promise<NotificationSubscription[]> {
      return db
        .select()
        .from(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.organizationId, organizationId),
            eq(notificationSubscription.category, category),
            eq(notificationSubscription.enabled, true),
          ),
        );
    },

    /**
     * Distinct userIds that have ANY subscription row (enabled OR disabled)
     * for one (org, category). The dispatcher uses this to know who has made
     * an explicit choice — those members are EXCLUDED from the org-default
     * fallback so an opt-out (a disabled row) is respected and nobody is
     * double-fired.
     */
    async listUserIdsWithSubscription(
      organizationId: string,
      category: string,
    ): Promise<string[]> {
      const rows = await db
        .selectDistinct({ userId: notificationSubscription.userId })
        .from(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.organizationId, organizationId),
            eq(notificationSubscription.category, category),
          ),
        );
      return rows.map((r) => r.userId);
    },

    /**
     * Idempotent upsert by (user, org, category, channel). Used both
     * by the Settings UI (toggling rows on/off) and by the default-
     * subscription seeder when a user joins an org.
     */
    async upsert(input: {
      userId: string;
      organizationId: string;
      category: string;
      channelId: string;
      enabled: boolean;
    }): Promise<NotificationSubscription> {
      const id = generateId("nsb");
      await db
        .insert(notificationSubscription)
        .values({ id, ...input })
        .onConflictDoUpdate({
          target: [
            notificationSubscription.userId,
            notificationSubscription.organizationId,
            notificationSubscription.category,
            notificationSubscription.channelId,
          ],
          set: { enabled: input.enabled, updatedAt: new Date() },
        });
      const [row] = await db
        .select()
        .from(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.userId, input.userId),
            eq(notificationSubscription.organizationId, input.organizationId),
            eq(notificationSubscription.category, input.category),
            eq(notificationSubscription.channelId, input.channelId),
          ),
        )
        .limit(1);
      return row;
    },

    async delete(id: string, userId: string, organizationId: string): Promise<void> {
      // Scope by owning userId too: a subscription belongs to one user, and the
      // org-singleton `notifications:write` tag only checks org membership — so
      // without this filter any member could delete another member's row.
      await db
        .delete(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.id, id),
            eq(notificationSubscription.userId, userId),
            eq(notificationSubscription.organizationId, organizationId),
          ),
        );
    },

    /** Wipe all subscriptions for one (user, org). Called on member removal. */
    async deleteAllForMember(userId: string, organizationId: string): Promise<void> {
      await db
        .delete(notificationSubscription)
        .where(
          and(
            eq(notificationSubscription.userId, userId),
            eq(notificationSubscription.organizationId, organizationId),
          ),
        );
    },
  };
}

// ─── notification_default repo ───────────────────────────────────────────────

export function createNotificationDefaultRepo(db: Database) {
  return {
    /** Every org-level default. Drives both the admin settings UI and
     *  the auto-subscription seeder. */
    async listByOrganization(organizationId: string): Promise<NotificationDefault[]> {
      return db
        .select()
        .from(notificationDefault)
        .where(eq(notificationDefault.organizationId, organizationId));
    },

    /** Idempotent upsert keyed on (org, category). */
    async upsert(input: {
      organizationId: string;
      category: string;
      defaultEnabled: boolean;
      defaultChannelKinds: ChannelKind[];
    }): Promise<NotificationDefault> {
      await db
        .insert(notificationDefault)
        .values(input)
        .onConflictDoUpdate({
          target: [notificationDefault.organizationId, notificationDefault.category],
          set: {
            defaultEnabled: input.defaultEnabled,
            defaultChannelKinds: input.defaultChannelKinds,
            updatedAt: new Date(),
          },
        });
      const [row] = await db
        .select()
        .from(notificationDefault)
        .where(
          and(
            eq(notificationDefault.organizationId, input.organizationId),
            eq(notificationDefault.category, input.category),
          ),
        )
        .limit(1);
      return row;
    },
  };
}

// ─── notification_delivery repo ──────────────────────────────────────────────

export function createNotificationDeliveryRepo(db: Database) {
  return {
    /** One delivery per verified source event, recipient and channel, including retries. */
    async createOnce(key: string, data: Omit<NewNotificationDelivery, "id" | "createdAt">): Promise<void> {
      const id = `nde_${createHash("sha256").update(JSON.stringify([data.organizationId, key, data.userId, data.channelId])).digest("hex")}`;
      await db.insert(notificationDelivery).values({ id, ...data }).onConflictDoNothing();
    },

    /** Dashboard inbox — newest deliveries for one user in one org. */
    async listForUser(
      userId: string,
      organizationId: string,
      opts?: { limit?: number; unseenOnly?: boolean; offset?: number; excludeFailed?: boolean; before?: string },
    ): Promise<NotificationDelivery[]> {
      const conditions = [
        eq(notificationDelivery.userId, userId),
        eq(notificationDelivery.organizationId, organizationId),
      ];
      if (opts?.unseenOnly) {
        conditions.push(sql`${notificationDelivery.seenAt} IS NULL`);
      }
      if (opts?.excludeFailed) conditions.push(sql`${notificationDelivery.status} != 'failed'`);
      if (opts?.before) {
        // Compare in SQL so the cursor retains PostgreSQL's timestamp precision.
        // A missing or foreign cursor yields no rows, never another user's history.
        conditions.push(sql`(${notificationDelivery.createdAt}, ${notificationDelivery.id}) < (
          SELECT cursor.created_at, cursor.id FROM notification_delivery AS cursor
          WHERE cursor.id = ${opts.before} AND cursor.user_id = ${userId}
            AND cursor.organization_id = ${organizationId}
        )`);
      }
      return db
        .select()
        .from(notificationDelivery)
        .where(and(...conditions))
        .orderBy(desc(notificationDelivery.createdAt), desc(notificationDelivery.id))
        .limit(opts?.limit ?? 100)
        .offset(opts?.offset ?? 0);
    },

    async findById(id: string): Promise<NotificationDelivery | undefined> {
      const [row] = await db
        .select()
        .from(notificationDelivery)
        .where(eq(notificationDelivery.id, id))
        .limit(1);
      return row;
    },

    async create(
      data: Omit<NewNotificationDelivery, "id" | "createdAt">,
    ): Promise<NotificationDelivery> {
      const id = generateId("nde");
      const [row] = await db
        .insert(notificationDelivery)
        .values({ id, ...data })
        .returning();
      return row;
    },

    /** Atomically claim rows; concurrent workers cannot send the same queued row. */
    async claimQueued(limit = 25): Promise<NotificationDelivery[]> {
      return db.transaction(async tx => {
        const rows = await tx.select().from(notificationDelivery).where(or(
          and(eq(notificationDelivery.status, "queued"), lte(notificationDelivery.nextAttemptAt, new Date())),
          and(eq(notificationDelivery.status, "sending"), sql`${notificationDelivery.payload}->>'durable' = 'true'`,
            sql`(${notificationDelivery.leaseUntil} IS NULL OR ${notificationDelivery.leaseUntil} <= NOW())`),
        ))
          .orderBy(notificationDelivery.createdAt).limit(limit).for("update", { skipLocked: true });
        if (rows.length) await tx.update(notificationDelivery)
          .set({ status: "sending", attempts: sql`${notificationDelivery.attempts} + 1`, leaseUntil: sql`NOW() + INTERVAL '60 seconds'` })
          .where(inArray(notificationDelivery.id, rows.map(row => row.id)));
        return rows;
      });
    },

    /** The claim attempt fences stale workers from changing a replacement's outcome. */
    async renewLease(id: string, attempt: number): Promise<boolean> {
      const rows = await db.update(notificationDelivery).set({ leaseUntil: sql`NOW() + INTERVAL '60 seconds'` })
        .where(and(eq(notificationDelivery.id, id), eq(notificationDelivery.status, "sending"),
          eq(notificationDelivery.attempts, attempt), sql`${notificationDelivery.leaseUntil} > NOW()`))
        .returning();
      return rows.length === 1;
    },

    /** Critical billing alerts use at-least-once delivery, retaining the same delivery ID. */
    async failInterrupted(reason: string): Promise<void> {
      await db.update(notificationDelivery).set({
        status: sql`CASE WHEN ${notificationDelivery.payload}->>'durable' = 'true' THEN 'queued' ELSE 'failed' END`,
        nextAttemptAt: new Date(), leaseUntil: null, lastError: reason,
      }).where(eq(notificationDelivery.status, "sending"));
    },

    async markSent(id: string, attempt?: number): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({ status: "sent", sentAt: new Date(), leaseUntil: null })
        .where(and(eq(notificationDelivery.id, id), attempt === undefined ? undefined :
          and(eq(notificationDelivery.status, "sending"), eq(notificationDelivery.attempts, attempt))));
    },

    async markFailed(id: string, error: string, retry: boolean, attempt?: number): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({
          status: retry ? "queued" : "failed",
          leaseUntil: null,
          lastError: error,
          nextAttemptAt: sql`CASE WHEN ${notificationDelivery.payload}->>'durable' = 'true'
            THEN NOW() + LEAST(3600, POWER(2, LEAST(${notificationDelivery.attempts}, 12))) * INTERVAL '1 second'
            ELSE NOW() END`,
        })
        .where(and(eq(notificationDelivery.id, id), attempt === undefined ? undefined :
          and(eq(notificationDelivery.status, "sending"), eq(notificationDelivery.attempts, attempt))));
    },

    /** Inbox acknowledgement is independent of delivery progress. Only an
     * already-sent delivery may transition to seen; pending/failed deliveries
     * retain their worker state, and repeated views preserve the first clock. */
    async markSeen(id: string, userId: string, organizationId: string): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({
          status: sql`CASE WHEN ${notificationDelivery.status} = 'sent' THEN 'seen' ELSE ${notificationDelivery.status} END`,
          seenAt: sql`coalesce(${notificationDelivery.seenAt}, NOW())`,
        })
        .where(
          and(
            eq(notificationDelivery.id, id),
            eq(notificationDelivery.userId, userId),
            eq(notificationDelivery.organizationId, organizationId),
          ),
        );
    },

    async unseenCount(userId: string, organizationId: string): Promise<number> {
      const [{ value }] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(notificationDelivery)
        .where(
          and(
            eq(notificationDelivery.userId, userId),
            eq(notificationDelivery.organizationId, organizationId),
            sql`${notificationDelivery.seenAt} IS NULL`,
            // Don't show failed deliveries in the unread count.
            sql`${notificationDelivery.status} != 'failed'`,
          ),
        );
      return Number(value ?? 0);
    },
  };
}
