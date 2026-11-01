import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import type {
  ClusterStorageConfig,
  ClusterStorageProgress,
  ClusterStorageObservation,
  ClusterStorageStatus,
} from "@repo/core";
import { organization } from "./organization";
import { computeCluster } from "./compute-cluster";
import { clusterRuntime } from "./cluster-runtime";

export const clusterStorage = pgTable(
  "cluster_storage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => computeCluster.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id")
      .notNull()
      .references(() => clusterRuntime.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    config: jsonb("config").$type<ClusterStorageConfig>().notNull(),
    status: text("status").$type<ClusterStorageStatus>().notNull().default("setting_up"),
    intent: text("intent").$type<"setup" | "remove">().notNull().default("setup"),
    generation: integer("generation").notNull().default(1),
    sequence: integer("sequence").notNull().default(1),
    progress: jsonb("progress")
      .$type<ClusterStorageProgress>()
      .notNull()
      .default({ steps: [], logs: [] }),
    observation: jsonb("observation").$type<ClusterStorageObservation>(),
    error: text("error"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cluster_storage_cluster_idx").on(t.clusterId),
    check(
      "cluster_storage_status_check",
      sql`${t.status} IN ('setting_up','ready','failed','interrupted','removing','removed')`,
    ),
    check("cluster_storage_intent_check", sql`${t.intent} IN ('setup','remove')`),
  ],
);
