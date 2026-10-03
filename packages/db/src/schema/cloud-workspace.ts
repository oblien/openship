import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import type { ManagedCommandRef } from "@repo/core";

/** Durable intent. A crashed worker resumes the same provider operation. */
export interface CloudWorkspaceOperation {
  id: string;
  kind: "ensure" | "resize" | "delete";
  status: "queued" | "running" | "failed" | "succeeded";
  requestedAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  logs: string[];
  /** Retain the last result for logs and safe retries of a lost HTTP response. */
  completedAt?: string;
  revision?: string;
  /** Upstream revision for a linked server; local revision also covers its projects. */
  remoteRevision?: string;
  resources?: { cpuCores: number; memoryMb: number; diskMb: number };
  restartWorkloads?: { wasRunning: boolean; containers: string[]; processes: string[] };
  /** Membership approved by the operator before the host restart. */
  restartProjectIds?: string[];
}

/** A connected installation retains only the verified remote execution identity.
 * Subscription state and host provisioning remain authoritative in Cloud. */
export interface LinkedCloudServer {
  apiUrl: string;
  userId: string;
  organizationId: string;
  serverId: string;
  workspaceId: string;
}

/** A durable critical section, not an expiring lease. Losing a connection must
 * never admit a host resize while its original deployment can still run. */
export interface CloudWorkspaceActivity {
  id: string;
  controllerId: string;
  scope: string;
  startedAt: string;
  /** Linked controllers persist completion before acknowledging it upstream. */
  settled?: boolean;
  /** Commands whose exit has not yet been verified, including lost start replies. */
  commands?: ManagedCommandRef[];
}

/** Minimal presence registry for projects controlled by connected installations.
 * Project configuration stays in its original database. */
export interface LinkedServerProjects {
  controllerId: string;
  projects: Array<{ id: string; name: string }>;
}

/** A subscription and execution target. Provider VM identities belong to its runtime. */
export const cloudWorkspace = pgTable(
  "cloud_workspace",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    namespace: text("namespace"),
    remote: jsonb("remote").$type<LinkedCloudServer>(),
    // Mirrors only. Provider reads authorize billing and execution.
    planTierId: text("plan_tier_id").notNull().default("free"),
    subscriptionStatus: text("subscription_status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    deletionInProgress: timestamp("deletion_in_progress"),
    operation: jsonb("operation").$type<CloudWorkspaceOperation>(),
    activity: jsonb("activity").$type<CloudWorkspaceActivity>(),
    linkedProjects: jsonb("linked_projects").$type<LinkedServerProjects[]>().notNull().default([]),
    // Durable purchase intents, not a payment ledger. Provider status alone
    // decides when a checkout can no longer charge this workspace.
    pendingCheckouts: jsonb("pending_checkouts")
      .$type<Array<{ request: Record<string, unknown>; checkoutId?: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cloud_workspace_namespace_unique").on(table.namespace),
    uniqueIndex("cloud_workspace_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("cloud_workspace_remote_unique").on(
      sql`(${table.remote}->>'apiUrl')`,
      sql`(${table.remote}->>'organizationId')`,
      sql`(${table.remote}->>'serverId')`,
    ),
    index("cloud_workspace_org_idx").on(table.organizationId),

  ],
);

/** Written with final deletion. A permission-filtered 404 is not a receipt. */
export const cloudServerDeletion = pgTable("cloud_server_deletion", {
  serverId: text("server_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  organizationId: text("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(),
  deletedAt: timestamp("deleted_at").notNull().defaultNow(),
});
