import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import type { ClusterRuntimePlan, ClusterRuntimeStatus } from "@repo/core";
import { computeCluster } from "./compute-cluster";
import { organization } from "./organization";

/** Keeps ownership after a failed install. Only verified cleanup releases a cluster. */
export const clusterRuntime = pgTable(
  "cluster_runtime",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => computeCluster.id, { onDelete: "no action" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clusterRevision: integer("cluster_revision").notNull(),
    requestId: text("request_id").notNull(),
    provider: text("provider").$type<"k3s" | "swarm">().notNull().default("k3s"),
    status: text("status").$type<ClusterRuntimeStatus>().notNull(),
    intent: text("intent").$type<"setup" | "remove">().notNull().default("setup"),
    generation: integer("generation").notNull().default(1),
    sequence: integer("sequence").notNull().default(1),
    plan: jsonb("plan").$type<ClusterRuntimePlan>().notNull(),
    error: text("error"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    verifiedAt: timestamp("verified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cluster_runtime_cluster_idx").on(table.clusterId),
    index("cluster_runtime_org_status_idx").on(table.organizationId, table.status),
    check("cluster_runtime_provider_check", sql`${table.provider} IN ('k3s', 'swarm')`),
    uniqueIndex("cluster_runtime_swarm_identity_idx")
      .on(table.organizationId, sql`(${table.plan}->>'clusterUid')`)
      .where(sql`${table.provider} = 'swarm'`),
    check(
      "cluster_runtime_status_check",
      sql`${table.status} IN ('setting_up','ready','failed','interrupted','removing','removed')`,
    ),
    check("cluster_runtime_intent_check", sql`${table.intent} IN ('setup','remove')`),
  ],
);
