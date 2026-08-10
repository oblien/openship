import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { deployment } from "./deployment";
import type { ComposeAdvanced } from "@repo/core";

/**
 * The compose-owned fields of a service — the shape stored in `importedSpec`
 * (last-imported baseline) and `driftSpec` (pending upstream) for 3-way drift
 * reconciliation. Routing (exposed/domain/…) is deliberately excluded: it's
 * user-owned and never counts as upstream drift.
 */
export type ComposeServiceSpec = {
  image?: string | null;
  build?: string | null;
  dockerfile?: string | null;
  ports?: string[];
  dependsOn?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  command?: string | null;
  /**
   * #332: structured argv for the container Cmd. `null` = no override (use image
   * CMD); `[]` = clear the image CMD; `[...]` = argv passed verbatim (NO implicit
   * `sh -c`). The text `command` above is kept for display / legacy rows; when
   * `commandArgv` is null the runtime falls back to `sh -c command` (legacy).
   */
  commandArgv?: string[] | null;
  restart?: string | null;
  advanced?: ComposeAdvanced;
};

/**
 * One public route on a service: a single container port published under its
 * own domain. A service with N public ports (e.g. Convex's API on 3210 +
 * HTTP actions on 3211) stores one entry per port. Entry[0] mirrors the scalar
 * `exposed`/`exposedPort`/`domain`/`customDomain`/`domainType` columns (the
 * primary route), which stay authoritative for single-route readers.
 */
export type ServicePublicEndpoint = {
  port: number;
  domainType: "free" | "custom";
  /** Free managed subdomain label (no base domain). */
  domain?: string;
  /** Full custom hostname bound to this port. */
  customDomain?: string;
};

// ─── Services ────────────────────────────────────────────────────────────────

/**
 * Deployable units within a project.
 *
 * Two flavors share this table, discriminated by the `kind` column:
 *
 *   - `kind = "compose"` - a docker-compose service (image / Dockerfile + ports).
 *     The original use case. Build/start commands come from the Dockerfile or
 *     image, so the build/install/start columns below stay null.
 *
 *   - `kind = "monorepo"` - a sub-app inside a monorepo. Each row carries the
 *     full single-app build config (rootDirectory, install/build/start
 *     commands, port, framework). N rows live under one project that shares
 *     one workspace install at the repo root.
 *
 * Routing / env scoping / multi-service deploy fan-out is identical for both
 * kinds, so the existing infrastructure (buildServiceRouteDomain, envVar.serviceId,
 * MultiServiceRuntimeAdapter) works for monorepo apps without forking.
 */
export const service = pgTable("service", {
  id: text("id").primaryKey(), // "svc_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),

  /** Discriminator: "compose" (docker-compose service) | "monorepo" (sub-app in a workspace) */
  kind: text("kind").notNull().default("compose"),

  /** Service name (from compose, e.g. "web", "db", "redis") - also used as hostname on the network */
  name: text("name").notNull(),
  /** Docker image (e.g. "postgres:16", "redis:7-alpine") - null if service is built from source */
  image: text("image"),
  /** Build context path relative to repo root (e.g. ".", "./services/api") - null if using a pre-built image */
  build: text("build"),
  /** Dockerfile path relative to build context - null to use default "Dockerfile" */
  dockerfile: text("dockerfile"),

  /* ── Networking ─────────────────────────────────────────────────────── */
  /** JSON array of port mappings (e.g. ["8080:3000", "5432"]) */
  ports: jsonb("ports").$type<string[]>().default([]),
  /** JSON array of service names this service depends on */
  dependsOn: jsonb("depends_on").$type<string[]>().default([]),

  /* ── Configuration ──────────────────────────────────────────────────── */
  /** JSON object of environment variables (non-secret defaults from compose) */
  environment: jsonb("environment").$type<Record<string, string>>().default({}),
  /** JSON array of volume mounts (e.g. ["pgdata:/var/lib/postgresql/data"]) */
  volumes: jsonb("volumes").$type<string[]>().default([]),
  /**
   * Whether this service's NAMED volumes are project-scoped (openship-<slug>-<name>)
   * at deploy time. True for services created after the volume-namespacing change;
   * backfilled to false for pre-existing services so they keep their bare volume
   * names and lose no data (see volume-namespace.ts). Bind mounts are unaffected.
   */
  namespaceVolumes: boolean("namespace_volumes").notNull().default(true),
  /** Override command (text form — display / legacy `sh -c` fallback, see #332) */
  command: text("command"),
  /**
   * #332: structured argv for the container Cmd (docker-compose semantics —
   * overrides image CMD, no implicit `sh -c`). Null = legacy row → runtime falls
   * back to `sh -c command`. `[]` = clear image CMD. Additive/nullable, so no
   * backfill; new parses/edits populate it.
   */
  commandArgv: jsonb("command_argv").$type<string[]>(),
  /** Restart policy: no | always | on-failure | unless-stopped */
  restart: text("restart").default("unless-stopped"),
  /**
   * Extended compose fields (healthcheck now; labels/entrypoint/caps/… later)
   * that don't warrant their own columns. See ComposeAdvanced. Honored by the
   * Docker runtime; runtimes that can't (cloud) warn-and-drop. Widening the
   * type needs no migration — it's a JSONB blob.
   */
  advanced: jsonb("advanced").$type<ComposeAdvanced>().default({}),

  /* ── Public routing ─────────────────────────────────────────────── */
  /** Whether this service should be exposed publicly through routing */
  exposed: boolean("exposed").notNull().default(false),
  /** Container port to expose publicly */
  exposedPort: text("exposed_port"),
  /** Free subdomain label for managed routing */
  domain: text("domain"),
  /** Custom domain bound directly to this service */
  customDomain: text("custom_domain"),
  /** Whether the service uses a free or custom domain */
  domainType: text("domain_type").default("free"),
  /**
   * Additional public routes beyond the primary one held by the scalar columns
   * above. Each entry publishes one container port under its own domain, so a
   * service with several public ports gets one route each. Entry[0] mirrors the
   * primary scalar routing columns. Widening needs no migration — JSONB blob.
   */
  publicEndpoints: jsonb("public_endpoints").$type<ServicePublicEndpoint[]>().default([]),

  /* ── Monorepo sub-app config (kind === "monorepo" only) ────────────── */
  /** Sub-app root directory inside the repo (e.g. "apps/web"). Null for compose. */
  rootDirectory: text("root_directory"),
  /** Per-app install command (run after the shared workspace install). Null for compose. */
  installCommand: text("install_command"),
  /** Per-app build command. Null for compose. */
  buildCommand: text("build_command"),
  /** Per-app start command - what the long-running workload runs. Null for compose. */
  startCommand: text("start_command"),
  /** Build output directory relative to the sub-app's root. Null for compose. */
  outputDirectory: text("output_directory"),
  /** Detected framework (e.g. "nextjs", "vite"). Null for compose. */
  framework: text("framework"),
  /** Package manager (npm/pnpm/yarn/bun). Null for compose. */
  packageManager: text("package_manager"),
  /** Build image / runtime base (e.g. "node:22"). Null for compose. */
  buildImage: text("build_image"),
  /**
   * Per-service overrides for "files that force this service to
   * rebuild on any change" — added on top of (not replacing) the
   * project-level `alwaysRebuildPaths` list. Globs are repo-root-
   * relative. Honored by the smart per-service deploy change
   * detector; null = no service-specific overrides.
   */
  alwaysRebuildGlobs: jsonb("always_rebuild_globs").$type<string[] | null>(),

  /* ── Drift reconciliation (compose re-parse) ────────────────────────── */
  /**
   * The compose spec as last imported from the repo — the "base" for 3-way
   * drift merge on redeploy. Null on rows created before this existed →
   * treated as fully user-owned until the next import establishes a baseline.
   */
  importedSpec: jsonb("imported_spec").$type<ComposeServiceSpec>(),
  /**
   * Pending upstream compose spec awaiting user approval — set when the repo
   * compose changed a field the user had edited. Null = no pending drift.
   */
  driftSpec: jsonb("drift_spec").$type<ComposeServiceSpec>(),

  /* ── State ──────────────────────────────────────────────────────────── */
  /** Whether this service should be deployed (allows disabling individual services) */
  enabled: boolean("enabled").notNull().default(true),
  /** Display / dependency order (lower = deployed first) */
  sortOrder: integer("sort_order").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Build pipeline + deployment setup iterate services per project.
  index("idx_service_project_id").on(t.projectId),
]);

// ─── Service deployments ─────────────────────────────────────────────────────

/**
 * Per-service deployment state.
 *
 * A project deployment fans out into one row per enabled service.
 * Used by the smart per-service deploy path to track which services
 * built vs which were skipped (unchanged + not forced), and by the
 * GitHub Checks integration to mirror per-service results back as
 * individual check runs.
 *
 * Status values: `pending | building | deploying | success | failure | skipped | cancelled`.
 * - `skipped` — service was unchanged AND `deployment.forceAll = false`.
 * - `success` — supersedes the legacy `running` / `ready` state.
 * Free-text column with no DB check constraint so new values can be
 * added without a migration.
 */
export const serviceDeployment = pgTable(
  "service_deployment",
  {
    id: text("id").primaryKey(), // "sd_..."
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployment.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),

    /**
     * Service name snapshotted at deploy time so historical rows
     * remain meaningful even after the service is renamed or removed.
     */
    serviceName: text("service_name"),

    /** Docker container ID */
    containerId: text("container_id"),
    /** Per-service status — see table-level doc for allowed values. */
    status: text("status").notNull().default("pending"),
    /**
     * Why this service was built (or not). Values:
     *   - `"changed"`        — files under the service root were touched.
     *   - `"forced"`         — `deployment.forceAll = true`.
     *   - `"config-touched"` — a path in `alwaysRebuildPaths` was touched.
     *   - `"shared-touched"` — a monorepo `monorepoSharedPaths` glob hit.
     *   - `"manual"`         — single-service redeploy from the dashboard.
     *   - `"unchanged"`      — no signals matched; service was skipped.
     */
    reason: text("reason"),
    /**
     * Mirror of `reason` when status = "skipped" — preserved for
     * legacy callers that read `reasonSkipped` rather than `reason`.
     * Newer callers should prefer `reason` since it also captures the
     * "why we DID build" side of the answer.
     */
    reasonSkipped: text("reason_skipped"),
    /** Resolved image reference (pulled or built) — the TAG, e.g. `n8nio/n8n:latest`. */
    imageRef: text("image_ref"),
    /**
     * Content-addressable digest of the image actually running, e.g.
     * `n8nio/n8n@sha256:…`. Captured from the container's RepoDigests at deploy.
     * This is the anchor that lets the update scanner detect a moved mutable tag
     * (`:latest`/`:1`) — `imageRef` alone can't, since the tag string is unchanged.
     */
    imageDigest: text("image_digest"),
    /** Mapped host port */
    hostPort: integer("host_port"),
    /** Internal network IP */
    ip: text("ip"),
    /** External URL where this service is reachable (mirrors deployment.url for the multi-service shape) */
    url: text("url"),

    /* ── Lifecycle timings ──────────────────────────────────────────── */
    /** When the per-service build/deploy started. Null until picked up. */
    startedAt: timestamp("started_at"),
    /** When the per-service build/deploy finished (success OR failure). */
    finishedAt: timestamp("finished_at"),
    /** Wall-clock duration in ms (`finishedAt - startedAt`). Denormalized for cheap aggregations. */
    durationMs: integer("duration_ms"),
    /** Failure message when status = "failure". Null for non-failure states. */
    errorMessage: text("error_message"),
    /**
     * Backward-compatible alias of `errorMessage`. Older callers wrote
     * to `error`; newer ones write to `errorMessage`. Keep both
     * columns until callers converge.
     */
    error: text("error"),

    /* ── GitHub Checks integration ──────────────────────────────────── */
    /**
     * GitHub `check_run.id` mirrored from this service deployment.
     * Null on non-PR / non-GitHub deploys. Bigint because GitHub's id
     * space exceeds 32-bit.
     */
    checkRunId: bigint("check_run_id", { mode: "number" }),
    /** Public URL of the GitHub check run (denormalized for the dashboard). */
    checkRunUrl: text("check_run_url"),

    /* ── Logs pointer ────────────────────────────────────────────────── */
    /**
     * Pointer into the deployment's build_session.logs structure
     * scoping which log section belongs to this service (e.g.
     * "section:<id>"). Free-form string; null for pre-fan-out logs.
     */
    logsRef: text("logs_ref"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One row per (deployment, service). The smart deploy path needs
    // to upsert by this pair without racing two parallel fan-outs.
    // This also serves the "list all per-service rows belonging to a
    // deployment" lookup — deployment_id is the leading column — so no
    // separate `ix_service_deployment_deployment` is needed.
    uniqueIndex("uq_service_deployment_dep_svc").on(t.deploymentId, t.serviceId),
    // "Latest deploy per service, newest first" — used by the per-
    // service status pill on the project page.
    index("ix_service_deployment_service_status").on(t.serviceId, t.status),
    index("ix_service_deployment_service_created").on(t.serviceId, t.createdAt),
  ],
);
