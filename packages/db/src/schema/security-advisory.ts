import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { organization } from "./organization";
import { user } from "./auth";

/** Public upstream cache; never contains credentials or customer inventory. */
export const advisoryFeed = pgTable("advisory_feed", {
  id: text("id").primaryKey(),
  body: jsonb("body"),
  etag: text("etag"),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  authenticationRejected: boolean("authentication_rejected").notNull().default(false),
  checkedAt: timestamp("checked_at"),
  nextCheckAt: timestamp("next_check_at").notNull().defaultNow(),
  leaseUntil: timestamp("lease_until"),
  failures: integer("failures").notNull().default(0),
  error: text("error"),
});

/** Inventory is local, scoped and tied to an immutable active deployment. */
export const projectSecurity = pgTable(
  "project_security",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => project.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id"),
    inventory: jsonb("inventory"),
    checkedAt: timestamp("checked_at"),
    autoRefresh: boolean("auto_refresh").notNull().default(false),
    evaluatedAt: timestamp("evaluated_at"),
    feedRevision: bigint("feed_revision", { mode: "number" }).notNull().default(0),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_project_security_org").on(t.organizationId)],
);

/** One admission per advisory revision + deployed artifact. Failed work requires review. */
export const securityRefreshAttempt = pgTable("security_refresh_attempt", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  deploymentId: text("deployment_id"),
  advisoryId: text("advisory_id"),
  actionRequestId: text("action_request_id"),
  serviceId: text("service_id"),
  image: text("image"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
