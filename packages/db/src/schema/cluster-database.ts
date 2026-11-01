import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ClusterDatabaseConfig,
  ClusterDatabaseProgress,
  ClusterDatabaseObservation,
  ClusterDatabaseStatus,
  ClusterDatabaseRestoreSource,
} from "@repo/core";
import { organization } from "./organization";
import { project } from "./project";
import { computeCluster } from "./compute-cluster";
import { clusterRuntime } from "./cluster-runtime";

/** A long-lived operator resource; never part of an application's release retirement. */
export const clusterDatabase = pgTable(
  "cluster_database",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => computeCluster.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id")
      .notNull()
      .references(() => clusterRuntime.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<ClusterDatabaseConfig>().notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    status: text("status").$type<ClusterDatabaseStatus>().notNull().default("provisioning"),
    intent: text("intent").$type<"apply" | "remove" | "backup">().notNull().default("apply"),
    backupRequestId: text("backup_request_id"),
    restoreSource: jsonb("restore_source").$type<ClusterDatabaseRestoreSource>(),
    deleteData: boolean("delete_data").notNull().default(false),
    generation: integer("generation").notNull().default(1),
    sequence: integer("sequence").notNull().default(1),
    progress: jsonb("progress")
      .$type<ClusterDatabaseProgress>()
      .notNull()
      .default({ steps: [], logs: [] }),
    observation: jsonb("observation").$type<ClusterDatabaseObservation>(),
    error: text("error"),
    envKey: text("env_key"),
    /** Exact encrypted value inserted by Connect; detaching never deletes a user's replacement. */
    envValueEncrypted: text("env_value_encrypted"),
    /** Optional reader endpoint; owns only the exact encrypted env value it inserted. */
    readEnvKey: text("read_env_key"),
    readEnvValueEncrypted: text("read_env_value_encrypted"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cluster_database_request_idx").on(t.projectId, t.requestId),
    uniqueIndex("cluster_database_name_idx")
      .on(t.projectId, t.name)
      .where(sql`${t.status} <> 'deleted'`),
    index("cluster_database_runtime_idx").on(t.runtimeId, t.status),
    check(
      "cluster_database_status_check",
      sql`${t.status} IN ('provisioning','ready','failed','interrupted','deleting','retained','deleted')`,
    ),
    check("cluster_database_intent_check", sql`${t.intent} IN ('apply','remove','backup')`),
  ],
);
