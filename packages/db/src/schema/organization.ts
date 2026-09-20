import { pgTable, text, timestamp, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import type { ExecutionAuthority } from "@repo/core";
import { user } from "./auth";

/**
 * Better Auth `organization` plugin tables.
 *
 * One organization = one "account/workspace" in product language.
 * Resources (projects, deployments, servers, etc.) are scoped to an
 * organization, not a user. Users belong to one or more orgs via the
 * `member` table.
 *
 * Schema mirrors Better Auth's organization plugin defaults; column
 * names + types must match `betterAuth({ plugins: [organization()] })`
 * expectations or the plugin's queries break.
 */

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  metadata: text("metadata"), // JSON-stringified blob the plugin manages
  isTeam: boolean("is_team").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),

  // ── Billing ───────────────────────────────────────────────────────────────
  // The active tier is denormalized here so per-request authorization checks
  // ("can this org do X on the pro tier?") don't have to join through
  // billing_subscription. The source of truth for subscription state is
  // Oblien entitlement API; webhook notifications and polling refresh this
  // mirror. Historical billing_subscription rows are retained for migration.
  /** 'free' | 'pro' | 'team' | 'enterprise' */
  planTierId: text("plan_tier_id").notNull().default("free"),
  /** Mirrors billing_customer.stripe_customer_id for fast lookup. */
  stripeCustomerId: text("stripe_customer_id"),
  /** 'active' | 'past_due' | 'canceled' | 'credit_exhausted' | 'trialing' */
  subscriptionStatus: text("subscription_status").notNull().default("active"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  /** Oblien-side namespace for this org's metered resources. Set when the
   *  org is provisioned in Oblien; null for orgs that haven't been
   *  onboarded to metered billing yet. */
  oblienNamespace: text("oblien_namespace").unique(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("member_org_user_unique").on(t.organizationId, t.userId),
    index("member_org_idx").on(t.organizationId),
    index("member_user_idx").on(t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("pending"), // "pending" | "accepted" | "rejected" | "canceled" | "expired"
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    executionAuthority: jsonb("execution_authority").$type<ExecutionAuthority>(),
  },
  (t) => [
    index("invitation_org_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);
