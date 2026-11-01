import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/** Payment ownership and resumable requests; the provider remains the ledger. */
export const managementBilling = pgTable("management_billing", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "restrict" }),
  namespace: text("namespace").notNull().unique(),
  namespaceReady: boolean("namespace_ready").notNull().default(false),
  cloudCoveredUntil: timestamp("cloud_covered_until"),
  checkout: jsonb("checkout").$type<{
    request: Record<string, unknown>;
    id?: string;
    canceling?: boolean;
  }>(),
  change: jsonb("change").$type<{
    quoteId: string;
    request: Record<string, unknown>;
    confirmationKey: string;
    id?: string;
  }>(),
  verified: jsonb("verified").$type<{
    plan?: "basic" | "priority";
    servers: number;
    baseIncluded: boolean;
    priceCents: number;
    periodEnd: string;
    cancelAtPeriodEnd: boolean;
    status: string;
    newServerLimit?: number;
  }>(),
  checkedAt: timestamp("checked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
