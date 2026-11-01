import { pgTable, text, timestamp, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { project } from "./project";

/** Private credential state, separate from public endpoint/routing JSON. */
export const routeProtection = pgTable(
  "route_protection",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    /** Lock intent survives secret-free exports. Missing credentials never unlock. */
    enabled: boolean("enabled").notNull().default(true),
    /** AES-GCM sealed verifier and signing key. */
    secret: text("secret"),
    revision: text("revision").notNull(),
    appliedRevision: text("applied_revision"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("route_protection_project_host").on(t.projectId, t.hostname)],
);
