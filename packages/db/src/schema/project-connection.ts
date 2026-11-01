import { pgTable, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { project } from "./project";
import { service } from "./service";
import { clusterDatabase } from "./cluster-database";

// ─── Service connections (app → project wiring) ─────────────────────────────

/**
 * Links a SOURCE project (a database app — Supabase, MongoDB, …) into a TARGET
 * consumer project: the consumer gets one resolved connection URL injected as a
 * project-level secret env var (`envKey`). Internal service links join the
 * source's Docker network; native database links authorize the consumer's
 * namespace through the database network policy on the same cluster.
 * One database instance, many links, with ownership retained by the source.
 *
 * The source FK is RESTRICTive (like backup_policy → destination): deleting a DB
 * app that's still linked fails loudly so a consumer never silently loses its
 * connection. The target FK cascades — dropping the consumer removes its links.
 */
export const projectConnection = pgTable(
  "project_connection",
  {
    id: text("id").primaryKey(), // "conn_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The DB app whose connection is consumed. RESTRICT — unlink before delete. */
    sourceProjectId: text("source_project_id")
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    /** Stable service identity; null for legacy/project-level app outputs. */
    sourceServiceId: text("source_service_id").references(() => service.id, {
      onDelete: "restrict",
    }),
    /** An explicitly shared native database; ownership stays with its source project. */
    sourceDatabaseId: text("source_database_id").references(() => clusterDatabase.id, {
      onDelete: "restrict",
    }),
    /** The consumer project the env var is injected into. */
    targetProjectId: text("target_project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Which `getAppConnectionView` output supplies the value (e.g. "dbUrl"). */
    outputId: text("output_id").notNull(),
    /** Env var name injected into the target (e.g. DATABASE_URL / MONGODB_URI). */
    envKey: text("env_key").notNull(),
    /** "internal" = private Docker network or native database namespace access;
     *  "public" = the published host:port URL. */
    mode: text("mode").notNull().default("public"),
    /** Tokens and passwords can be shared without granting network access. */
    usesPrivateNetwork: boolean("uses_private_network").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One env var per target can't be driven by two links.
    uniqueIndex("uq_project_connection_target_env").on(t.targetProjectId, t.envKey),
    index("idx_project_connection_target").on(t.targetProjectId),
    index("idx_project_connection_source").on(t.sourceProjectId),
    index("idx_project_connection_source_service").on(t.sourceServiceId),
    index("idx_project_connection_source_database").on(t.sourceDatabaseId),
  ],
);
