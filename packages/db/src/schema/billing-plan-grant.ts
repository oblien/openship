import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/** Operator-issued, complimentary plans. Never writable through tenant settings. */
export const billingPlanGrant = pgTable("billing_plan_grant", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  planTierId: text("plan_tier_id").notNull(),
  /** The catalog allowance and limits at issuance, independent of future pricing edits. */
  offer: jsonb("offer").notNull(),
  limits: jsonb("limits").notNull(),
  grantedBy: text("granted_by").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  releaseReason: text("release_reason"),
  /** Set only after provider cleanup succeeds, or a hosted subscription takes over. */
  releasedAt: timestamp("released_at", { withTimezone: true }),
  /** Provider resetQuota uses this timestamp as its durable idempotency key. */
  appliedPeriodEnd: timestamp("applied_period_end", { withTimezone: true }),
}, (t) => [
  uniqueIndex("billing_plan_grant_current_org").on(t.organizationId).where(sql`${t.releasedAt} IS NULL`),
  index("billing_plan_grant_org_created").on(t.organizationId, t.createdAt),
]);
