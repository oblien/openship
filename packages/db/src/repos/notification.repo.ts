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

import { and, desc, eq, sql } from "drizzle-orm";
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

export type ChannelKind = "email" | "webhook" | "in_app" | "slack" | "discord" | "msteams";
export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "seen";

// ─── notification_channel repo ───────────────────────────────────────────────

export function createNotificationChannelRepo(db: Database) {
  return {
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
      defaultChannelKind: ChannelKind;
    }): Promise<NotificationDefault> {
      await db
        .insert(notificationDefault)
        .values(input)
        .onConflictDoUpdate({
          target: [notificationDefault.organizationId, notificationDefault.category],
          set: {
            defaultEnabled: input.defaultEnabled,
            defaultChannelKind: input.defaultChannelKind,
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
    /** Dashboard inbox — newest deliveries for one user in one org. */
    async listForUser(
      userId: string,
      organizationId: string,
      opts?: { limit?: number; unseenOnly?: boolean },
    ): Promise<NotificationDelivery[]> {
      const conditions = [
        eq(notificationDelivery.userId, userId),
        eq(notificationDelivery.organizationId, organizationId),
      ];
      if (opts?.unseenOnly) {
        conditions.push(sql`${notificationDelivery.seenAt} IS NULL`);
      }
      return db
        .select()
        .from(notificationDelivery)
        .where(and(...conditions))
        .orderBy(desc(notificationDelivery.createdAt))
        .limit(opts?.limit ?? 100);
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

    /** Worker picks up queued deliveries oldest-first. */
    async claimQueued(limit = 25): Promise<NotificationDelivery[]> {
      return db
        .select()
        .from(notificationDelivery)
        .where(eq(notificationDelivery.status, "queued"))
        .orderBy(notificationDelivery.createdAt)
        .limit(limit);
    },

    async markSending(id: string): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({ status: "sending", attempts: sql`${notificationDelivery.attempts} + 1` })
        .where(eq(notificationDelivery.id, id));
    },

    async markSent(id: string): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(notificationDelivery.id, id));
    },

    async markFailed(id: string, error: string, retry: boolean): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({
          status: retry ? "queued" : "failed",
          lastError: error,
        })
        .where(eq(notificationDelivery.id, id));
    },

    /** User clicks the in-app bell row. */
    async markSeen(id: string, userId: string, organizationId: string): Promise<void> {
      await db
        .update(notificationDelivery)
        .set({ status: "seen", seenAt: new Date() })
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
