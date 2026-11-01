import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

/** Financial records are independent of short-lived workflow logs and monthly
 * app-server subscriptions. Only verified deposits are mirrored locally; Oblien owns usage debits. */
export const actionBudget = pgTable(
  "action_budget",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "restrict" }),
    namespace: text("namespace").notNull().unique(),
    fundedUnits: bigint("funded_units", { mode: "number" }).notNull().default(0),
    /** Applied customer runner catalog; zero means payment recovery must finish setup. */
    runnerVersion: integer("runner_version").notNull().default(0),
    runnerSetupFailed: boolean("runner_setup_failed").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "action_budget_amounts_check",
      sql`${t.fundedUnits} BETWEEN 0 AND 9007199254740991 AND ${t.runnerVersion} >= 0`,
    ),
  ],
);

export const actionCreditPurchase = pgTable(
  "action_credit_purchase",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => actionBudget.organizationId, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    priceCents: integer("price_cents").notNull(),
    /** The complete immutable provider request, saved before opening checkout. */
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    checkoutId: text("checkout_id"),
    checkoutUrlEnc: text("checkout_url_enc"),
    status: text("status").notNull().default("pending"),
    /** Provider-confirmed NET credit after refunds/disputes, never browser data. */
    fundedUnits: bigint("funded_units", { mode: "number" }).notNull().default(0),
    checkedAt: timestamp("checked_at"),
    /** Durable receipt recovery, including a lost checkout response. Null only
     * after expiry; a verified payment event can request another check. */
    nextCheckAt: timestamp("next_check_at").defaultNow(),
    checkAttempts: integer("check_attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_purchase_key_unique").on(t.organizationId, t.idempotencyKey),
    uniqueIndex("action_purchase_checkout_unique").on(t.checkoutId),
    index("action_purchase_pending_idx").on(t.status, t.checkedAt),
    index("action_purchase_check_idx")
      .on(t.nextCheckAt, t.id)
      .where(sql`${t.nextCheckAt} IS NOT NULL`),
    check(
      "action_purchase_amounts_check",
      sql`${t.priceCents} > 0 AND ${t.fundedUnits} BETWEEN 0 AND ${t.priceCents}::bigint * 600000`,
    ),
    check("action_purchase_check_attempts_check", sql`${t.checkAttempts} BETWEEN 0 AND 10`),
  ],
);
