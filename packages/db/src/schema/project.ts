import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { RoutingConfig, ReleaseSource } from "@repo/core";
import { organization } from "./organization";
import { service } from "./service";

// ─── Project apps ────────────────────────────────────────────────────────────

/**
 * Parent grouping for deployable project environments.
 *
 * Product language can keep calling this a "Project". The existing `project`
 * table remains the deployable environment instance that owns deployments,
 * domains, env vars, logs, analytics, and runtime settings.
 */
export const projectGroup = pgTable("project_app", {
  id: text("id").primaryKey(), // "app_..."
  /** Org that owns this app — THE access primitive. Creator info lives
   *  in audit_event (event_type='project.create'). */
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),

  /** Display name shared by all environments */
  name: text("name").notNull(),
  /** URL-safe slug shared by the app */
  slug: text("slug").notNull(),

  /** Shared source identity */
  gitProvider: text("git_provider").default("github"),
  gitOwner: text("git_owner"),
  gitRepo: text("git_repo"),
  gitUrl: text("git_url"),
  installationId: integer("installation_id"),

  /** Shared favicon cache */
  favicon: text("favicon"),
  faviconCheckedAt: timestamp("favicon_checked_at"),

  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * Deployable project environment. Each row is one isolated runtime target
 * under a project app, e.g. Production on main or Development on develop.
 * It owns deployments, domains, env vars, logs, analytics, and runtime settings.
 */
export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(), // "proj_..."
    /** Org that owns this project — THE access primitive. Creator info
     *  lives in audit_event (event_type='project.create'). */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    groupId: text("app_id")
      .notNull()
      .references(() => projectGroup.id, { onDelete: "cascade" }),

    /** Display name (e.g. "My Next App") */
    name: text("name").notNull(),
    /** URL-safe slug derived from name */
    slug: text("slug").notNull(),

    /* ── Environment identity ─────────────────────────────────────────── */
    /** Display label for this deployable environment */
    environmentName: text("environment_name").notNull().default("Production"),
    /** Stable URL-safe environment key */
    environmentSlug: text("environment_slug").notNull().default("production"),
    /** Environment class */
    environmentType: text("environment_type").notNull().default("production"),

    /* ── App marker ───────────────────────────────────────────────────────── */
    /**
     * True when this project was created from the one-click Apps catalog
     * (Convex, WordPress, webmail, …) rather than as a user code deployment.
     * Purely a classification: it moves the project to the Apps tab and shows a
     * catalog logo/badge — the project internals are unchanged. Distinct from
     * `groupId`, which is the FK to the project_app grouping row.
     */
    isApp: boolean("is_app").notNull().default(false),
    /** Catalog template id this app was installed from (e.g. "convex", "mail-webmail"). */
    appTemplateId: text("app_template_id"),

    /* ── Source ───────────────────────────────────────────────────────────── */
    /** Absolute path on disk for locally-imported projects */
    localPath: text("local_path"),

    /* ── Git source ─────────────────────────────────────────────────────── */
    /**
     * Source discriminator: "github" | "gitlab" | "bitbucket" | "local" | "upload" | "release".
     * (Free-text; canonical set = SOURCE_PROVIDERS in @repo/core.)
     *   - "local"  → folder on a filesystem the API can read (desktop/self-hosted),
     *                path in `localPath`.
     *   - "upload" → source came from a browser folder-upload; no durable origin
     *                (re-upload to redeploy). Can be switched to "github" later via
     *                the repo-link flow, becoming a normal git project.
     *   - "release" → a prebuilt DIST (no repo, no build). Redeploys track a
     *                VERSION, not a commit. Config lives in `releaseSource`.
     */
    gitProvider: text("git_provider").default("github"),
    /** Owner/org on the git provider */
    gitOwner: text("git_owner"),
    /** Repo name on the git provider */
    gitRepo: text("git_repo"),
    /** Default branch to deploy from */
    gitBranch: text("git_branch").default("main"),
    /** Full clone URL */
    gitUrl: text("git_url"),
    /** Installation ID for GitHub App access */
    installationId: integer("installation_id"),
    /**
     * Per-project clone-token override (encrypted via lib/encryption).
     * When set, this is the first credential `resolveCloneToken` returns -
     * highest priority in the chain. Users add this in the project's
     * Resources tab when they want to scope a Fine-Grained PAT or PAT-like
     * credential to just this project.
     */
    cloneTokenEncrypted: text("clone_token_encrypted"),
    /** Timestamp of last update (for UI "last set X ago"). Null if cleared. */
    cloneTokenSetAt: timestamp("clone_token_set_at"),

    /**
     * Release/dist source config (only when gitProvider === "release"). Either a
     * GitHub-Releases asset (repo + assetTemplate) or an external HTTPS tarball
     * (distUrl + sha256). `trackReleases` opts the project into release-webhook
     * auto-deploy. See ReleaseSource in @repo/core.
     */
    releaseSource: jsonb("release_source").$type<ReleaseSource | null>(),

    /* ── Build configuration ────────────────────────────────────────────── */
    /** Detected framework (nextjs, vite, node, static, etc.) */
    framework: text("framework").default("unknown"),
    /** Package manager (npm, yarn, pnpm, bun) */
    packageManager: text("package_manager").default("npm"),
    /** Custom install command override */
    installCommand: text("install_command"),
    /** Custom build command override */
    buildCommand: text("build_command"),
    /** Build output directory */
    outputDirectory: text("output_directory"),
    /** Files/directories needed at runtime (JSON string array, e.g. [".next","node_modules","package.json"]) */
    productionPaths: text("production_paths"),
    /** Root directory within the repo (for monorepos) */
    rootDirectory: text("root_directory"),
    /** Start command for production runtime */
    startCommand: text("start_command"),
    /** Docker image for build environment (e.g. node:22, oven/bun:latest) */
    buildImage: text("build_image"),
    /** Production mode: host, static, standalone */
    productionMode: text("production_mode").default("host"),
    /** Port the app listens on (inside the container / the bare process). */
    port: integer("port").default(3000),
    /**
     * Pinned LOOPBACK host port the edge proxies to under the `loopback-port`
     * route strategy (docker publishes `127.0.0.1:<hostPort>:<port>`). Stable
     * across redeploys/restarts; null until first allocated. Mirrors
     * `service.hostPort`. Unused by bare (the app owns 127.0.0.1:<port>) and by
     * `container-ip` mode.
     */
    hostPort: integer("host_port"),
    /**
     * How the edge addresses this app's upstream: "auto" (default → loopback
     * host port), "loopback-port", or "container-ip" (advanced, bridge IP).
     * Snapshotted onto each deployment's config, like `runtimeMode`.
     */
    routeStrategy: text("route_strategy").default("auto"),
    /** Whether the project needs a running server (false = static site, deployed via Pages) */
    hasServer: boolean("has_server").notNull().default(true),
    /** Whether the project needs a build step (false = deploy source files directly) */
    hasBuild: boolean("has_build").notNull().default(true),

    /**
     * Shell command run ONCE at the repo root before any per-app build —
     * any preparatory work the workspace needs before sub-app builds can
     * proceed. Common uses: workspace install (`pnpm install -w`), code
     * generation (`pnpm prisma generate`), schema sync, plugin setup.
     * Multiple steps chain with `&&`.
     *
     * Only used when projectType === "monorepo". Optional — leave null for
     * single-app builds or monorepos that need nothing at the workspace
     * level.
     *
     * Distinct from the per-sub-app `installCommand`: this runs ONCE at
     * /workspace before any per-service build; `installCommand` runs per
     * sub-app inside its own root directory.
     */
    workspacePrepareCommand: text("workspace_prepare_command"),

    /* ── Resources (VM-native format) ───────────────────────────────────── */
    /** JSON: { cpuCores, memoryMb } */
    resources: jsonb("resources"),
    /** JSON: build-specific resource overrides */
    buildResources: jsonb("build_resources"),
    /** Sleep mode: auto_sleep | always_on */
    sleepMode: text("sleep_mode").default("auto_sleep"),
    /**
     * Runtime isolation mode for this project's deploys: "bare" (direct host
     * process) | "docker" (isolated container). Editable in the Runtime tab and
     * snapshotted onto each deployment's config. Null = resolve the default at
     * deploy time (the prior wizard-only behavior).
     */
    runtimeMode: text("runtime_mode"),
    /** Number of previous successful releases to retain for rollback (null = use instance default) */
    rollbackWindow: integer("rollback_window"),
    /**
     * Default rollback strategy snapshotted onto each new deployment
     * via `deployment.rollbackStrategy`.
     *
     *   - `"git"`      → no archive; rollback checks out the previous
     *     successful deploy's commit_sha and rebuilds in place. Saves
     *     disk at the cost of build time on restore. Default for new
     *     projects since most are GitHub-backed and commits ARE the
     *     rollback fuel.
     *   - `"snapshot"` → archive image/workspace, rollback restores it.
     *     Use when build is expensive and instant rollback matters.
     *
     * Stored per-project so a project can opt into either mode without
     * touching the global default.
     */
    defaultRollbackStrategy: text("default_rollback_strategy")
      .notNull()
      .default("git"),
    /**
     * One-shot "rebuild every service on the next deploy regardless of
     * what changed" flag. Used by the dashboard's force-deploy toggle.
     * The build pipeline reads it, propagates it to
     * `deployment.forceAll`, and clears this flag in the same
     * transaction that creates the deployment. Self-clearing — never
     * leave it true across multiple deploys.
     */
    forceDeployNext: boolean("force_deploy_next").notNull().default(false),
    /**
     * Globs (relative to repo root) for files that, when touched in
     * a monorepo project, force every sub-app to rebuild — packages
     * the apps depend on. Null = no shared-paths force is applied at
     * all (smart per-service deploy only). Explicit `[]` is treated the
     * same as null. Operators must opt-in: in pnpm-workspace layouts
     * `packages/web` is itself a deployable service, so a built-in
     * default of `["packages/", "libs/"]` would force-rebuild
     * everything on every push to a sub-app. Honored only for monorepo
     * projects; ignored on compose / single-app deploys. Project-update
     * validation rejects any prefix that overlaps an existing service's
     * `rootDirectory`.
     */
    monorepoSharedPaths: jsonb("monorepo_shared_paths").$type<string[] | null>(),
    /**
     * Globs (relative to repo root) for files that force a full
     * rebuild project-wide when touched — config / build files where
     * skipping a service would risk silent staleness (e.g.
     * `package.json`, `bun.lockb`, `pnpm-lock.yaml`, `Dockerfile`,
     * `docker-compose.yml`). When null the change detector falls back
     * to a built-in default list. Per-service overrides live on
     * `service.alwaysRebuildGlobs`.
     */
    alwaysRebuildPaths: jsonb("always_rebuild_paths").$type<string[] | null>(),
    /**
     * Routing config parsed from the repo's `vercel.json` (rewrites / redirects
     * / headers / cleanUrls / trailingSlash). Compiled to OpenResty at deploy
     * time (see `compileVercelRouting`) so the single-domain composition and
     * redirects/headers match what the repo declares. Null when the repo has no
     * routing config. Widening the shape needs no migration (jsonb).
     */
    routingConfig: jsonb("routing_config").$type<RoutingConfig | null>(),
    /**
     * How Cloud deployments preserve their rollback artifact:
     *   - "inplace"  → Oblien `snapshots.createArchive` + `workspace.stop`.
     *                  Disk + archive remain attached to the workspace;
     *                  compute paused. Rollback starts it back up.
     *   - "offload"  → Reserved for future self-hosted external-S3
     *                  shipping. Not implemented on Openship Cloud.
     *
     * Bare/Docker runtimes ignore this column.
     */
    cloudArchiveStrategy: text("cloud_archive_strategy").notNull().default("inplace"),

    /**
     * Oblien workspace id this project deploys to — the LINK, not a
     * mirror. Like `gitOwner/gitRepo` points at GitHub, this points
     * at Oblien. Runtime state, files, logs all live on Oblien.
     *
     * `cloudWorkspaceId IS NOT NULL` is the canonical "this is a
     * cloud project" test. The per-deployment `deployTarget` already
     * lives in `deployment.meta` (snapshot per deploy); duplicating
     * it on the project row creates two sources of truth for the
     * same fact. Set by build.service after a successful workspace
     * provision. Unique-per-project (the partial unique index below
     * enforces that we never bind two local projects to the same
     * workspace).
     */
    cloudWorkspaceId: text("cloud_workspace_id"),

    /* ── State ──────────────────────────────────────────────────────────── */
    /** Currently active deployment ID */
    activeDeploymentId: text("active_deployment_id"),
    /** GitHub webhook ID registered on the repo */
    webhookId: integer("webhook_id"),
    /** Domain hostname used for receiving GitHub webhooks (null = edge relay or none) */
    webhookDomain: text("webhook_domain"),
    /**
     * Per-project GitHub webhook signing secret (encrypted via lib/encryption).
     * Generated fresh when the webhook is registered/rotated; sent to GitHub
     * in the hook config and used by the webhook verifier to HMAC-check
     * inbound deliveries for THIS project. Null on legacy projects that
     * were registered before per-project secrets existed — the verifier
     * falls back to env.GITHUB_WEBHOOK_SECRET for those.
     */
    webhookSecret: text("webhook_secret"),
    /** Whether pushes to the branch trigger auto-deploy */
    autoDeploy: boolean("auto_deploy").notNull().default(false),
    /** Auto-detected favicon URL from the deployed site */
    favicon: text("favicon"),
    /** Last time favicon detection was attempted for this project */
    faviconCheckedAt: timestamp("favicon_checked_at"),
    /** Soft delete */
    deletedAt: timestamp("deleted_at"),
    /**
     * Set true at the start of the atomic teardown flow so concurrent
     * requests refuse to operate on the row. The teardown either succeeds
     * (row hard-deletes — flag disappears with it) or fails (flag is
     * cleared so the caller can retry). NEVER stays true at rest.
     */
    deletionInProgress: boolean("deletion_in_progress").notNull().default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_project_app_environment_slug_active")
      .on(table.groupId, table.environmentSlug)
      .where(sql`${table.deletedAt} IS NULL`),
    // One local project per Oblien workspace. Two project rows pointing
    // at the same workspace would race on deploy + confuse drift
    // detection. Partial unique — NULL allowed (self-hosted projects
    // or pre-first-deploy), but any non-null value is unique.
    uniqueIndex("uq_project_cloud_workspace_id")
      .on(table.cloudWorkspaceId)
      .where(sql`${table.cloudWorkspaceId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  ],
);

// ─── Environment variables ───────────────────────────────────────────────────

/**
 * Per-project environment variables.
 * Values are encrypted at rest (application-level encryption).
 * Each var can be scoped to specific environments.
 */
export const envVar = pgTable("env_var", {
  id: text("id").primaryKey(), // "env_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** Service ID for service-scoped env vars (null = project-level / all services) */
  serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),

  /** Variable key (e.g. "DATABASE_URL") */
  key: text("key").notNull(),
  /** Encrypted value */
  value: text("value").notNull(),
  /** Environments where this var is active */
  environment: text("environment").notNull().default("production"), // production | preview | development

  /** Preview-only: don't include in production builds */
  isSecret: boolean("is_secret").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Env resolution runs on every build — covers project + service +
  // environment filtering used by buildPipelineEnv.
  index("idx_env_var_project_env_service").on(t.projectId, t.environment, t.serviceId),
  // Backup / restore reads all vars for a project.
  index("idx_env_var_project").on(t.projectId),
]);
