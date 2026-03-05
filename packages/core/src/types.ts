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

export type Framework = "nextjs" | "node" | "static" | "docker";

export type AdapterType = "docker" | "oblien";

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
