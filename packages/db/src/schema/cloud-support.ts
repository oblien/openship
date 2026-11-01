import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, boolean, index, check } from "drizzle-orm/pg-core";

/** Cloud support records. Customer access is explicitly scoped to ownerUserId;
 * anonymous intake stays operator-only. Never included in instance exports. */
export const cloudSupportTicket = pgTable(
  "cloud_support_ticket",
  {
    id: text("id").primaryKey(),
    inputHash: text("input_hash").notNull(),
    ownerUserId: text("owner_user_id"),
    category: text("category")
      .$type<"deployment" | "billing" | "account" | "general">()
      .notNull()
      .default("general"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    source: text("source").$type<"support" | "contact">().notNull(),
    status: text("status").$type<"open" | "resolved">().notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cloud_support_ticket_created").on(t.createdAt, t.id),
    index("cloud_support_ticket_owner_created").on(t.ownerUserId, t.createdAt, t.id),
    check(
      "cloud_support_ticket_category_check",
      sql`${t.category} IN ('deployment', 'billing', 'account', 'general')`,
    ),
    check("cloud_support_ticket_source_check", sql`${t.source} IN ('support', 'contact')`),
    check("cloud_support_ticket_status_check", sql`${t.status} IN ('open', 'resolved')`),
  ],
);

/** Ticket messages also form the durable mail outbox; no second mail queue. */
export const cloudSupportMessage = pgTable(
  "cloud_support_message",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => cloudSupportTicket.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"receipt" | "notification" | "reply" | "customer_reply">().notNull(),
    body: text("body"),
    resolve: boolean("resolve").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    leaseId: text("lease_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [
    check(
      "cloud_support_message_kind_check",
      sql`${t.kind} IN ('receipt', 'notification', 'reply', 'customer_reply')`,
    ),
    index("cloud_support_message_ticket").on(t.ticketId, t.createdAt),
    index("cloud_support_message_pending")
      .on(t.nextAttemptAt)
      .where(sql`${t.deliveredAt} IS NULL`),
  ],
);
