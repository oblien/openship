import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, jsonb, index, check } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

export interface CustomerPaymentEmail {
  scope: "hosting" | "management";
  workspaceId?: string;
  namespace: string;
  paymentId: string;
  amountCents: number;
  currency: "usd";
  productName: string;
}

/** SaaS transactional mail, separate from configurable infrastructure alerts.
 * Account deletion removes queued personal data. No historical mail is seeded. */
export const cloudCustomerEmail = pgTable(
  "cloud_customer_email",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"signup" | "purchase" | "invoice">().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    payment: jsonb("payment").$type<CustomerPaymentEmail>(),
    status: text("status")
      .$type<"pending" | "sent" | "canceled" | "failed">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    leaseId: text("lease_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cloud_customer_email_kind", sql`${t.kind} IN ('signup', 'purchase', 'invoice')`),
    check(
      "cloud_customer_email_status",
      sql`${t.status} IN ('pending', 'sent', 'canceled', 'failed')`,
    ),
    index("cloud_customer_email_due")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
