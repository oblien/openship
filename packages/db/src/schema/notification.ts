/**
 * Notification system tables.
 *
 * The notification pipeline is a CONSUMER of the audit_event stream:
 *
 *   event happens → audit_event row written → notification.emit() called
 *     → look up subscriptions for (org, category) → fan out to channels
 *     → channel workers send → notification_delivery row updated
 *
 * Tables:
 *   - notification_channel       per-user channel config (HOW they get notified)
 *   - notification_subscription  per-user × org × category × channel toggle
 *   - notification_default       per-org defaults for new members
 *   - notification_delivery      per-send audit + retry tracking
 *
 * Categories are stable strings the dispatcher knows about
 * (registered in notification-categories.ts):
 *   deploy.failed, deploy.succeeded, deploy.cancelled
 *   backup.failed, backup.succeeded
 *   domain.expiring, domain.verified
 *   member.added, member.removed, invitation.sent
 *   billing.alert, quota.warning
 *
 * Channel kinds:
 *   email     standard SMTP email to user's verified address
 *   webhook   POST to user-configured URL, signed with HMAC
 *   in_app    delivery row read by the dashboard's bell icon
 *   slack     POST to Slack incoming-webhook URL the user pasted
 *   discord   POST to Discord webhook URL with a markdown-aware embed
 *   msteams   POST Adaptive Card to a Teams Workflows / legacy connector webhook URL
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";
import { auditEvent } from "./audit-event";

// ─── notification_channel ────────────────────────────────────────────────────
// HOW a user gets notified. One user can have many channels.

export const notificationChannel = pgTable(
  "notification_channel",
  {
    id: text("id").primaryKey(), // "nch_..."
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** "email" | "webhook" | "in_app" | "slack" | "discord" | "msteams".
     *  Stored as text so we can add new channel kinds without a schema
     *  migration. The dispatcher's channel registry decides which kinds
     *  are dispatchable. */
    kind: text("kind").notNull(),

    /** Display label the user picks ("My personal Slack", "On-call email").
     *  Used in the dashboard channel list. */
    label: text("label").notNull(),

    /**
     * Channel-specific config:
     *   email   → { address: string }
     *   webhook → { url: string, hmacSecret: string (encrypted) }
     *   in_app  → {} (no config)
     *   slack   → { webhookUrl: string (encrypted), channelName?: string }
     *   discord → { webhookUrl: string (encrypted) }
     *   msteams → { webhookUrl: string (encrypted) }
     */
    config: jsonb("config").notNull().default({}),

    /** True only after we've proven the channel is reachable (email
     *  click-through, webhook returned 2xx, slack test message landed).
     *  Unverified channels are skipped at dispatch time. */
    verified: boolean("verified").notNull().default(false),

    /** Soft-disable without deleting — preserves delivery history. */
    enabled: boolean("enabled").notNull().default(true),

    /** Last successful delivery — used by the dashboard to surface
     *  "stale" channels (no traffic in 90d). */
    lastDeliveredAt: timestamp("last_delivered_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_notification_channel_user").on(table.userId)],
);

// ─── notification_subscription ───────────────────────────────────────────────
// WHAT a user wants to be notified about, in WHICH org, on WHICH channel.

export const notificationSubscription = pgTable(
  "notification_subscription",
  {
    id: text("id").primaryKey(), // "nsb_..."
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Stable category string (deploy.failed, backup.failed, etc.).
     *  Categories are defined in lib/notification-categories.ts —
     *  invalid categories are silently dropped by the dispatcher. */
    category: text("category").notNull(),

    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannel.id, { onDelete: "cascade" }),

    enabled: boolean("enabled").notNull().default(true),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One row per (user, org, category, channel). Re-subscribing flips
    // `enabled` rather than inserting a duplicate.
    uniqueIndex("uq_notification_subscription_unique").on(
      table.userId,
      table.organizationId,
      table.category,
      table.channelId,
    ),
    // Dispatch lookup: "every member of org X subscribed to category Y".
    index("idx_notification_subscription_dispatch").on(
      table.organizationId,
      table.category,
      table.enabled,
    ),
  ],
);

// ─── notification_default ────────────────────────────────────────────────────
// Per-org defaults for new members. When a user joins an org, the
// dispatcher's `applyDefaultSubscriptions` helper consults this table
// to seed their notification_subscription rows.

export const notificationDefault = pgTable(
  "notification_default",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    category: text("category").notNull(),

    /** Default enabled state when a new member joins. Admin-controlled
     *  via the org settings page. */
    defaultEnabled: boolean("default_enabled").notNull().default(true),

    /** Default channel kind for the auto-subscription. "email" by default.
     *  The dispatcher matches this to the user's first verified channel
     *  of that kind; if they have none, the subscription is created with
     *  channelId=null and surfaces in the dashboard as "needs channel". */
    defaultChannelKind: text("default_channel_kind").notNull().default("email"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notification_default_org_category").on(table.organizationId, table.category),
  ],
);

// ─── notification_delivery ───────────────────────────────────────────────────
// One row per (notification × channel) send attempt. Powers retries,
// the dashboard's in-app inbox, and the "what was sent when" audit.

export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: text("id").primaryKey(), // "nde_..."

    /** Recipient user. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Source audit event — the cause. ON DELETE SET NULL so we don't
     *  cascade-lose delivery history when an audit row gets pruned by
     *  retention. */
    auditEventId: text("audit_event_id").references(() => auditEvent.id, {
      onDelete: "set null",
    }),

    /** The dispatch category that routed this delivery. */
    category: text("category").notNull(),

    /** Channel used. ON DELETE SET NULL — keep delivery history when a
     *  user removes a channel. */
    channelId: text("channel_id").references(() => notificationChannel.id, {
      onDelete: "set null",
    }),
    /** Snapshot of channel kind so we can report on deleted channels. */
    channelKind: text("channel_kind").notNull(),

    /** queued | sending | sent | failed | seen
     *  - queued:  enqueued by the dispatcher, awaiting worker pickup
     *  - sending: worker holding the row
     *  - sent:    delivered (HTTP 2xx, SMTP accepted, etc.)
     *  - failed:  exhausted retries or unrecoverable error
     *  - seen:    user acknowledged (in-app bell click; email open is too
     *             noisy to track here) */
    status: text("status").notNull().default("queued"),

    /** Retry counter. Workers increment + back off exponentially. */
    attempts: integer("attempts").notNull().default(0),

    /** Rendered payload — subject + body for email, JSON for webhook, etc.
     *  Stored so retries don't re-render (avoids drift if templates
     *  change between attempts). */
    payload: jsonb("payload").notNull().default({}),

    /** Last error message on failure attempts (for debugging in the UI). */
    lastError: text("last_error"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
    /** When the user marked an in-app notification as read. */
    seenAt: timestamp("seen_at"),
  },
  (table) => [
    // Dashboard inbox: list a user's deliveries newest-first.
    index("idx_notification_delivery_user_created").on(table.userId, table.createdAt),
    // Worker queue scan: pick up queued rows in FIFO order.
    index("idx_notification_delivery_queued").on(table.status, table.createdAt),
    // Org-level "what notifications did this org send today" reports.
    index("idx_notification_delivery_org_created").on(table.organizationId, table.createdAt),
  ],
);
