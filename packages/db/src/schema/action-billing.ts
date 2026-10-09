import { sql } from "drizzle-orm";
import {
  bigint,
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
 * app-server subscriptions. Amounts use the exact Actions second-based unit. */
export const actionBudget = pgTable(
  "action_budget",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "restrict" }),
    namespace: text("namespace").notNull().unique(),
    fundedUnits: bigint("funded_units", { mode: "number" }).notNull().default(0),
    spentUnits: bigint("spent_units", { mode: "number" }).notNull().default(0),
    reservedUnits: bigint("reserved_units", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "action_budget_amounts_check",
      sql`${t.fundedUnits} BETWEEN 0 AND 9007199254740991 AND ${t.spentUnits} BETWEEN 0 AND 9007199254740991 AND ${t.reservedUnits} BETWEEN 0 AND 9007199254740991`,
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_purchase_key_unique").on(t.organizationId, t.idempotencyKey),
    uniqueIndex("action_purchase_checkout_unique").on(t.checkoutId),
    index("action_purchase_pending_idx").on(t.status, t.checkedAt),
    check(
      "action_purchase_amounts_check",
      sql`${t.priceCents} > 0 AND ${t.fundedUnits} BETWEEN 0 AND ${t.priceCents}::bigint * 600000`,
    ),
  ],
);

/** A receipt keeps its immutable job reference after execution history expires.
 * reserve() verifies ownership and the current controller lease before insertion. */
export const actionCharge = pgTable(
  "action_charge",
  {
    jobId: text("job_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => actionBudget.organizationId, { onDelete: "restrict" }),
    runnerPriceId: text("runner_price_id").notNull(),
    priceVersion: integer("price_version").notNull(),
    microUsdPerMinute: integer("micro_usd_per_minute").notNull(),
    reservedSeconds: integer("reserved_seconds").notNull(),
    reservedUnits: bigint("reserved_units", { mode: "number" }).notNull(),
    chargedSeconds: integer("charged_seconds"),
    chargedUnits: bigint("charged_units", { mode: "number" }),
    settledAt: timestamp("settled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("action_charge_org_idx").on(t.organizationId, t.createdAt),
    check(
      "action_charge_amounts_check",
      sql`${t.microUsdPerMinute} > 0 AND ${t.reservedSeconds} BETWEEN 1 AND 21600 AND ${t.reservedUnits} = ${t.reservedSeconds}::bigint * ${t.microUsdPerMinute}
    AND ((${t.settledAt} IS NULL AND ${t.chargedSeconds} IS NULL AND ${t.chargedUnits} IS NULL)
      OR (${t.settledAt} IS NOT NULL AND ${t.chargedSeconds} BETWEEN 0 AND ${t.reservedSeconds} AND ${t.chargedUnits} = ${t.chargedSeconds}::bigint * ${t.microUsdPerMinute}))`,
    ),
  ],
);
