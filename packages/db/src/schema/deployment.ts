import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { user } from "./auth";

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
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),

  /* ── Git snapshot ───────────────────────────────────────────────────── */
  branch: text("branch").notNull(),
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),

  /* ── Build details ──────────────────────────────────────────────────── */
  /** Environment: production | preview */
  environment: text("environment").notNull().default("production"),
  /** Detected or configured framework */
  framework: text("framework"),
  /** Build status */
  status: text("status").notNull().default("queued"),
  /** Image/snapshot reference produced by build */
  imageRef: text("image_ref"),
  /** Build duration in milliseconds */
  buildDurationMs: integer("build_duration_ms"),

  /* ── Container details ──────────────────────────────────────────────── */
  /** Adapter container ID (for stop/start/destroy) */
  containerId: text("container_id"),
  /** External URL where deployment is reachable */
  url: text("url"),

  /* ── Metadata ───────────────────────────────────────────────────────── */
  /** JSON: snapshot of build config used */
  meta: jsonb("meta"),
  /** Error message if failed */
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Build sessions ──────────────────────────────────────────────────────────

/**
 * Build session tracking — used for SSE log streaming.
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
