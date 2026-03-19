/**
 * Shared TypeScript types used across apps and packages.
 */

/* ---------- Deployment ---------- */

export type DeploymentStatus =
  | "queued"
  | "building"
  | "deploying"
  | "ready"
  | "failed"
  | "cancelled";

export type Environment = "production" | "preview" | "development";

import type { StackId, Language } from "./stacks";

/** Framework / stack identifier — derived from STACKS registry */
export type Framework = StackId;

/** Programming language — derived from LANGUAGES registry */
export type LanguageId = Language;

/**
 * Package manager identifier.
 * JS has npm/yarn/pnpm/bun, Go has go, Rust has cargo, Python has pip/poetry/uv, etc.
 * Kept as a string (not union) because new package managers can be added to LANGUAGES.
 */
export type PackageManager = string;

export type ProductionMode = "host" | "static" | "standalone";

/**
 * Build strategy — where the build process runs.
 *   "server" → Build in the workspace/cloud (default)
 *   "local"  → Build on the host machine
 */
export type BuildStrategy = "server" | "local";

/**
 * Deploy target — where the application runs after build.
 *   "local"  → This machine (desktop/dev)
 *   "server" → User's remote server via SSH (selfhosted)
 *   "cloud"  → Oblien cloud workspace
 */
export type DeployTarget = "local" | "server" | "cloud";

/**
 * Runtime mode — how the application process is managed.
 *   "bare"   → Direct process on the host (pm2 / systemd / nohup)
 *   "docker" → Container-based via Docker daemon
 */
export type RuntimeMode = "bare" | "docker";

export type AdapterType = "docker" | "oblien";

export type SleepMode = "auto_sleep" | "always_on";

export type DomainStatus = "pending" | "active" | "failed" | "removing";

export type SslStatus = "none" | "provisioning" | "active" | "expired" | "error";

/* ---------- Billing ---------- */

export type PlanId = "free" | "pro" | "team";

export type SubscriptionStatus = "active" | "canceled" | "past_due";

export type UsageMetric = "build_minutes" | "bandwidth_gb" | "deployments";

/* ---------- Auth ---------- */

export type UserRole = "user" | "admin";

export type TeamRole = "owner" | "admin" | "member";

/* ---------- API Responses ---------- */

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  perPage: number;
}
