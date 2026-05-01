import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth";

// ─── Project apps ────────────────────────────────────────────────────────────

/**
 * Parent grouping for deployable project environments.
 *
 * Product language can keep calling this a "Project". The existing `project`
 * table remains the deployable environment instance that owns deployments,
 * domains, env vars, logs, analytics, and runtime settings.
 */
export const projectApp = pgTable("project_app", {
  id: text("id").primaryKey(), // "app_..."
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),

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
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => projectApp.id, { onDelete: "cascade" }),

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

    /* ── Source ───────────────────────────────────────────────────────────── */
    /** Absolute path on disk for locally-imported projects */
    localPath: text("local_path"),

    /* ── Git source ─────────────────────────────────────────────────────── */
    /** Git provider ("github" | "gitlab" | "bitbucket" | "local") */
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
    /** Port the app listens on */
    port: integer("port").default(3000),
    /** Whether the project needs a running server (false = static site, deployed via Pages) */
    hasServer: boolean("has_server").notNull().default(true),
    /** Whether the project needs a build step (false = deploy source files directly) */
    hasBuild: boolean("has_build").notNull().default(true),

    /* ── Resources (VM-native format) ───────────────────────────────────── */
    /** JSON: { cpuCores, memoryMb } */
    resources: jsonb("resources"),
    /** JSON: build-specific resource overrides */
    buildResources: jsonb("build_resources"),
    /** Sleep mode: auto_sleep | always_on */
    sleepMode: text("sleep_mode").default("auto_sleep"),
    /** Number of previous successful releases to retain for rollback (null = use instance default) */
    rollbackWindow: integer("rollback_window"),

    /* ── State ──────────────────────────────────────────────────────────── */
    /** Currently active deployment ID */
    activeDeploymentId: text("active_deployment_id"),
    /** GitHub webhook ID registered on the repo */
    webhookId: integer("webhook_id"),
    /** Domain hostname used for receiving GitHub webhooks (null = edge relay or none) */
    webhookDomain: text("webhook_domain"),
    /** Whether pushes to the branch trigger auto-deploy */
    autoDeploy: boolean("auto_deploy").notNull().default(false),
    /** Auto-detected favicon URL from the deployed site */
    favicon: text("favicon"),
    /** Last time favicon detection was attempted for this project */
    faviconCheckedAt: timestamp("favicon_checked_at"),
    /** Soft delete */
    deletedAt: timestamp("deleted_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_project_app_environment_slug_active")
      .on(table.appId, table.environmentSlug)
      .where(sql`${table.deletedAt} IS NULL`),
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
  serviceId: text("service_id"),

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
});
