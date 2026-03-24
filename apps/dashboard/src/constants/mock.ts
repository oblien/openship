/**
 * Shared domain types used across the dashboard.
 *
 * Project shape matches the API response from /projects/home
 * (full DB row + latest-deployment enrichments).
 */

export interface Project {
  id: string;
  name: string;
  slug: string;

  /* ── Source ──────────────────────────────────────────────── */
  localPath?: string | null;
  gitProvider?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;

  /* ── Build configuration ────────────────────────────────── */
  framework: string;
  packageManager?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  startCommand?: string | null;
  buildImage?: string | null;
  productionMode?: string | null;
  port?: number | null;
  hasServer?: boolean;
  hasBuild?: boolean;

  /* ── State ──────────────────────────────────────────────── */
  activeDeploymentId?: string | null;
  latestDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;

  createdAt: string;
  updatedAt: string;
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
