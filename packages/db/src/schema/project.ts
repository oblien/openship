import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * Core project table. A project is a deployable unit linked to a Git repo.
 * Projects own deployments, domains, and environment variables.
 */
export const project = pgTable("project", {
  id: text("id").primaryKey(), // "proj_..."
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),

  /** Display name (e.g. "My Next App") */
  name: text("name").notNull(),
  /** URL-safe slug derived from name */
  slug: text("slug").notNull(),

  /* ── Git source ─────────────────────────────────────────────────────── */
  /** Git provider ("github" | "gitlab" | "bitbucket") */
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
  /** Root directory within the repo (for monorepos) */
  rootDirectory: text("root_directory"),
  /** Production mode: host, static, standalone */
  productionMode: text("production_mode").default("host"),
  /** Port the app listens on */
  port: integer("port").default(3000),

  /* ── Resources (VM-native format) ───────────────────────────────────── */
  /** JSON: { cpus, cpuConfig: { quotaUs, periodUs }, memoryMb } */
  resources: jsonb("resources"),
  /** JSON: build-specific resource overrides */
  buildResources: jsonb("build_resources"),
  /** Sleep mode: auto_sleep | always_on */
  sleepMode: text("sleep_mode").default("auto_sleep"),

  /* ── State ──────────────────────────────────────────────────────────── */
  /** Currently active deployment ID */
  activeDeploymentId: text("active_deployment_id"),
  /** Soft delete */
  deletedAt: timestamp("deleted_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
