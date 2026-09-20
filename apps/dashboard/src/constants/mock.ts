import type { ReleaseSource } from "@repo/core";

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
  /** Prebuilt release/archive or tracked registry-image source. */
  releaseSource?: ReleaseSource | null;

  /* ── Build configuration ────────────────────────────────── */
  framework: string;
  /** True when this project was installed from the Apps catalog (Convex, webmail, …).
   *  Drives the Apps-vs-Projects split; the detail UI is otherwise identical. */
  isApp?: boolean | null;
  /** Catalog entry this app was installed from (e.g. "convex", "mail-webmail"). */
  appTemplateId?: string | null;
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
  /** Resolved runtime workload ("web" | "worker" | "static", #538). A worker
   *  shares `hasServer=false` with a static site, so it's the only field that
   *  tells them apart on read-only surfaces (cards, chips). */
  workloadType?: string | null;

  /* ── State ──────────────────────────────────────────────── */
  activeDeploymentId?: string | null;
  latestDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;
  /** Human version (v1, v2, …) of the live release — from the active deployment. */
  activeVersion?: number | null;
  /** Status of the live release (e.g. `partial_failure`). */
  activeDeploymentStatus?: string | null;
  /** True when the live release is a partial-failure deploy awaiting keep/reject. */
  awaitingDecision?: boolean | null;
  /** True when the live release's edge/domain routes did not finish syncing. */
  routingUnsynced?: boolean | null;
  /** True when the latest failed deploy has a named, clearable blocker. */
  latestDeploymentBlocked?: boolean | null;
  /** Operator switch, derived from the project's disabled timestamp. */
  enabled?: boolean | null;
  /** Current project migration, when one is still running or awaiting a decision. */
  activeMigration?: {
    id: string;
    status: string;
    mode: string;
    needsAction?: boolean;
  } | null;
  serviceCount?: number;
  hasMultipleServices?: boolean;
  /** Set once soft-deleted; in practice teardown hard-deletes, so the list
   *  rarely sees this. */
  deletedAt?: string | null;
  /** True while an atomic teardown is in flight — drives the "Deleting" status
   *  in the list (the row is still returned because deletedAt is null). */
  deletionInProgress?: boolean | null;

  /* ── Hosting info (enriched by API) ─────────────────────── */
  favicon?: string | null;
  deployTarget?: string | null;
  serverId?: string | null;
  serverName?: string | null;
  /** Runtime isolation mode (bare | docker) — editable in the Runtime tab. */
  runtimeMode?: "bare" | "docker" | null;
  /**
   * Resource config as returned by /info (enrichProject → encodeResources):
   * production/build hold the actual { cpuCores, memoryMb }.
   */
  resources?: {
    production?: { cpuCores?: number; memoryMb?: number } | null;
    build?: { cpuCores?: number; memoryMb?: number } | null;
    sleepMode?: string;
    port?: number;
  } | null;

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
