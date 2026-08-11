import { pgTable, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";
import { organization } from "./organization";

/**
 * Cached result of the unified update scanner — one row per updatable entity
 * (every entity is a project row: git projects, release/dist projects, the
 * self-app, webmail, and installed template apps). The `updates:scan` job runs
 * the single resolver (`getProjectCommitStatus` — commit | release | image) and
 * upserts the outcome here so the dashboard home Updates block and the Apps tab
 * can render "new release for X" without recomputing drift on every page load.
 *
 * Source of truth for drift is always the live resolver; this table is a cache
 * refreshed by the scan (+ on demand), keyed uniquely by projectId.
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
    /** True when an update is available (any image service behind, new commit, higher semver). */
    behind: boolean("behind").notNull().default(false),
    /** The latest matching version/commit is already deploying — suppress the nudge. */
    latestInProgress: boolean("latest_in_progress").notNull().default(false),
    /** Human labels for the UI (e.g. "v0.3.1" / "abc1234" / "n8nio/n8n"). */
    currentLabel: text("current_label"),
    latestLabel: text("latest_label"),
    /** Full resolver payload (per-service image drift, branch, etc.) for the UI. */
    detail: jsonb("detail"),
    /** When this row was last refreshed by a scan. */
    checkedAt: timestamp("checked_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_update_status_project").on(t.projectId),
    // Home/Apps query: "everything in this org that has an update".
    index("idx_update_status_org_behind").on(t.organizationId, t.behind),
  ],
);
