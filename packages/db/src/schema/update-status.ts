import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";
import { organization } from "./organization";

/**
 * Cached UPSTREAM state for the unified update scanner — one row per updatable
 * entity (every entity is a project row: git projects, release/dist projects, the
 * self-app, webmail, and installed template apps). `updates:scan` polls what each
 * project's SOURCE currently offers (branch HEAD, newest release tag, registry
 * digest per service) and parks the answer here, because that side costs a
 * network round-trip per project and nothing local signals when it moves.
 *
 * This table holds ONLY that upstream side. It deliberately stores no `behind`
 * flag, no deployed version and no display labels: those depend on the project's
 * ACTIVE deployment, which seven code paths can change, and a cached copy of them
 * went stale between scans — advertising updates for commits already shipped.
 * They are computed on read instead (`evaluateDrift` + `updates.service`), so the
 * only invalidation this cache needs is "the project's source changed".
 */
export const updateStatus = pgTable(
  "update_status",
  {
    id: text("id").primaryKey(), // "ups_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Drift kind: "commit" | "release" | "image" (mirrors UpdatableKind). */
    kind: text("kind").notNull(),
    /**
     * The upstream payload, shaped by `kind`:
     *   commit  → { branch, latestSha, latestMessage }   (full sha — it gets compared)
     *   release → { latestVersion, pinned }
     *   image   → { services: [{ serviceId, name, ref, latestDigest }] }
     */
    detail: jsonb("detail"),
    /** When the upstream side was last polled. */
    checkedAt: timestamp("checked_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_update_status_project").on(t.projectId),
    // Home/Apps query: every cached row in this org (the behind/not-behind split
    // is computed after loading, so it can't be an index predicate).
    index("idx_update_status_org").on(t.organizationId),
  ],
);
