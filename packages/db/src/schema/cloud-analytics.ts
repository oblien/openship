import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, jsonb, integer, boolean, index } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/** Cloud-only telemetry outbox. No credentials, request bodies, or customer data. */
export const cloudAnalyticsEvent = pgTable(
  "cloud_analytics_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    event: text("event").notNull(),
    distinctId: text("distinct_id").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseId: text("lease_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // Small business-event receipts survive delivery, so a later webhook replay
    // cannot count a payment again. Browser traffic expires after 30 days.
    retain: boolean("retain").notNull().default(false),
  },
  (t) => [
    index("cloud_analytics_event_pending")
      .on(t.nextAttemptAt)
      .where(sql`${t.deliveredAt} IS NULL`),
    index("cloud_analytics_event_retention")
      .on(t.deliveredAt)
      .where(sql`${t.retain} = false`),
  ],
);

/** Checkout correlation/reconciliation; raw provider IDs stay in this database. */
export const cloudAnalyticsCheckout = pgTable(
  "cloud_analytics_checkout",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).defaultNow(),
    checks: integer("checks").notNull().default(0),
    status: text("status"),
  },
  (t) => [index("cloud_analytics_checkout_due").on(t.nextCheckAt)],
);

/** Last verified subscription state. Serializes changes across Cloud replicas. */
export const cloudAnalyticsWorkspace = pgTable("cloud_analytics_workspace", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  state: jsonb("state").$type<Record<string, unknown>>(),
  revision: integer("revision").notNull().default(0),
});
