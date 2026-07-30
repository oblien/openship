import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { project } from "./project";
import { organization } from "./organization";
import type { RuntimeWorkloadRef } from "@repo/core";

// ─── Deployments ─────────────────────────────────────────────────────────────

/**
 * Deployment records. Each deployment represents a single build → deploy cycle.
 * Many deployments belong to one project. Only one is "active" at a time.
 */
export const deployment = pgTable("deployment", {
  id: text("id").primaryKey(), // "dep_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** Org that owns this deployment — THE access primitive. Actor info
   *  (who triggered the deploy) flows through audit_event. */
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),

  /* ── Git snapshot ───────────────────────────────────────────────────── */
  branch: text("branch").notNull(),
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),
  /**
   * The previous successful-deploy commit_sha on this branch at the
   * moment this deployment was created. Captured up-front so the
   * git-strategy rollback path can `git checkout <sha>` even if a
   * later deploy has clobbered the working tree, and so the change
   * detector has a stable "diff from where" anchor when the webhook
   * payload's `before` is missing or unreliable (force-push, missing
   * compare data).
   */
  commitShaBefore: text("commit_sha_before"),
  /**
   * What triggered this deployment.
   *
   * Values: `manual | webhook | redeploy | rollback`. Free-text column
   * (no DB check constraint) — keep new values lowercase + hyphenated.
   */
  trigger: text("trigger").notNull().default("manual"),

  /* ── Build details ──────────────────────────────────────────────────── */
  /** Environment: production | preview */
  environment: text("environment").notNull().default("production"),
  /** Detected or configured framework */
  framework: text("framework"),
  /**
   * Build status.
   *
   * Values: `queued | building | deploying | ready | failed | cancelled | partial_failure | rejected`.
   * `rejected` is terminal: the operator declined a finished (ready /
   * partial_failure) deploy; its runtime is torn down but the row + logs are
   * kept for history (see rejectDeployment).
   * `partial_failure` is a terminal success-with-asterisk used by the
   * smart per-service deploy path when one or more services failed
   * but the rest came up ready — the dashboard treats it as deployed.
   * Free-text column (no DB check constraint) so callers can extend
   * without a migration; keep values lowercase + snake_case.
   */
  status: text("status").notNull().default("queued"),
  /** Image/snapshot reference produced by build */
  imageRef: text("image_ref"),
  /** Build duration in milliseconds */
  buildDurationMs: integer("build_duration_ms"),
  /**
   * Monotonic per-project deployment number (v1, v2, …) for human-friendly
   * history + the rollback UI. Assigned at create as MAX(version)+1 for the
   * project; the one-in-flight-per-project unique index serializes creates so
   * concurrent webhook races can't collide. Nullable for legacy rows created
   * before this column existed.
   */
  version: integer("version"),
  /**
   * Deployed release version for a release/dist-source project (semver, no
   * leading "v"). The queryable drift anchor: the "new version available"
   * banner compares this on the ACTIVE deployment against the latest advertised
   * release. Null for commit/upload/local deploys. Assigned at CREATE from the
   * resolved snapshot — like `commit_sha` (deploy identity), NOT like the human
   * `version` counter — so it's queryable while the build is still in flight
   * (in-flight new-version suppression + release-webhook dedupe).
   */
  releaseVersion: text("release_version"),

  /* ── Container details ──────────────────────────────────────────────── */
  /** Adapter container ID (for stop/start/destroy) */
  containerId: text("container_id"),
  /** Typed durable runtime identity. Legacy rows continue to use containerId. */
  runtimeRef: jsonb("runtime_ref").$type<RuntimeWorkloadRef | null>(),
  /** External URL where deployment is reachable */
  url: text("url"),

  /* ── Metadata ───────────────────────────────────────────────────────── */
  /** JSON: snapshot of build config used for this deployment */
  meta: jsonb("meta"),
  /** JSON: encrypted environment variables snapshot for this deployment */
  envVars: jsonb("env_vars"),
  /** Error message if failed */
  errorMessage: text("error_message"),

  /* ── Smart per-service deploy snapshot ──────────────────────────────── */
  /**
   * Union of file paths changed between `commitShaBefore` and
   * `commitSha`, as reported by the webhook (or the local git diff
   * fallback). `null` for non-webhook deploys where path-based change
   * detection doesn't apply (manual, redeploy, rollback). The change
   * detector reads this to decide which services to rebuild vs skip.
   *
   * Stored as `string[]`. May be truncated — see `changedPathsTruncated`.
   */
  changedPaths: jsonb("changed_paths").$type<string[] | null>(),
  /**
   * True when GitHub's commit-compare API capped the changed-files
   * array (300-file limit) and `changedPaths` is therefore a partial
   * list. The change detector treats this case as "rebuild everything"
   * because it cannot prove a service was untouched.
   */
  changedPathsTruncated: boolean("changed_paths_truncated").notNull().default(false),
  /**
   * True if this deployment intentionally rebuilt every service
   * regardless of whether files in their root changed. Set when:
   * `[force]` / `[force-deploy]` / `[redeploy-all]` appears in the
   * commit message, the dashboard's force-deploy toggle was active,
   * a config file at the repo root was touched, or this is a manual
   * "Deploy" trigger without a per-service target.
   */
  forceAll: boolean("force_all").notNull().default(false),
  /**
   * How the rollback artifact for THIS deployment is preserved /
   * restored.
   *
   *   - `"snapshot"` → existing path: container image + workspace
   *     snapshot are archived; rollback re-runs the same artifact.
   *   - `"git"`     → no artifact archive; rollback checks out
   *     `commitShaBefore` and rebuilds in place. Cheap on disk but
   *     pays a build cost on restore. Selected per-project via
   *     `project.defaultRollbackStrategy` and snapshotted onto the
   *     deployment at create time so changing the project setting
   *     later doesn't invalidate past rollback targets.
   */
  rollbackStrategy: text("rollback_strategy").notNull().default("snapshot"),

  /* ── Rollback / retention ───────────────────────────────────────────── */
  /**
   * Set by the rollback orchestrator when the artifact is archived
   * (preserved in non-active state for potential rollback). Nulled when
   * the artifact is purged. Read by the dashboard as "is this deployment
   * still rollbackable?". Only the orchestrator writes this column.
   */
  artifactRetainedAt: timestamp("artifact_retained_at"),
  /**
   * User-tagged "keep this version rollbackable indefinitely". Pinned
   * deployments are exempt from the orchestrator's retention prune
   * (project.rollbackWindow). Hard-capped per project via
   * instance_settings.maxPinnedDeployments to bound disk usage.
   */
  pinned: boolean("pinned").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // At most ONE in-flight deployment per project. The race-prone
  // pattern (SELECT-then-INSERT inside checkNoActiveBuild +
  // createQueuedDeployment) is replaced by relying on this constraint:
  // concurrent webhook deliveries both try the INSERT, only one wins,
  // the other's unique-violation is caught by the caller and reported
  // as "another build already in progress."
  uniqueIndex("uq_deployment_one_active_per_project")
    .on(t.projectId)
    .where(sql`status IN ('queued', 'building', 'deploying')`),
]);

// ─── Build sessions ──────────────────────────────────────────────────────────

/**
 * Build session tracking - used for SSE log streaming.
 * A build session maps 1:1 with a deployment during the build phase.
 * Logs are stored here for replay after the session ends.
 */
export const buildSession = pgTable("build_session", {
  id: text("id").primaryKey(), // "bld_..."
  deploymentId: text("deployment_id")
    .notNull()
    .references(() => deployment.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),

  /** Build session status */
  status: text("status").notNull().default("queued"),
  /** JSON array of log entries for replay */
  logs: jsonb("logs"),
  /** Build duration in milliseconds */
  durationMs: integer("duration_ms"),

  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
