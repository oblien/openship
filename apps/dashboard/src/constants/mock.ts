/**
 * Shared domain types used across the dashboard.
 *
 * Lightweight Project / Deployment shapes used by listing pages and
 * card components. Richer deployment data lives in
 *   @/app/(dashboard)/deployments/types.ts
 */

export interface Project {
  id: string;
  name: string;
  description: string;
  framework: string;
  url: string;
  status: "live" | "paused";
  lastDeployed: string;
  domain: string;
  isCustomDomain: boolean;
  deploymentCount: number;
  visitors: string;
  repo: string;
}

/** Simplified deployment record used in project-scoped deployment cards. */
export interface Deployment {
  id: string | number;
  projectName: string;
  /** Short commit hash or identifier */
  commit: string;
  status: "success" | "failed" | "building" | "pending" | "canceled" | "cancelled";
  branch: string;
  createdAt: string;
  /** Human-readable build duration, e.g. "1m 23s" */
  duration: string;
  url: string;
}
