import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { project } from "./project";

// ─── Service connections (app → project wiring) ─────────────────────────────

/**
 * Links a SOURCE project (a database app — Supabase, MongoDB, …) into a TARGET
 * consumer project: the consumer gets one resolved connection URL injected as a
 * project-level secret env var (`envKey`), and — in `internal` mode — its
 * containers join the source's `openship-<slug>` network so the URL can use the
 * internal service alias with no public port. One DB instance, many links (no
 * duplication).
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
    /** The consumer project the env var is injected into. */
    targetProjectId: text("target_project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Which `getAppConnectionView` output supplies the value (e.g. "dbUrl"). */
    outputId: text("output_id").notNull(),
    /** Env var name injected into the target (e.g. DATABASE_URL / MONGODB_URI). */
    envKey: text("env_key").notNull(),
    /** "internal" = shared docker network + service alias (no public port);
     *  "public" = the published host:port URL. */
    mode: text("mode").notNull().default("public"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One env var per target can't be driven by two links.
    uniqueIndex("uq_project_connection_target_env").on(t.targetProjectId, t.envKey),
    index("idx_project_connection_target").on(t.targetProjectId),
    index("idx_project_connection_source").on(t.sourceProjectId),
  ],
);
