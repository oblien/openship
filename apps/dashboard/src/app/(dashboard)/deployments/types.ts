export interface ServiceDeploymentSummary {
  id: string;
  serviceId: string;
  serviceName: string;
  /** Per-service deploy state. Maps to the `service_deployment.status` column. */
  status:
    | "pending"
    | "building"
    | "deploying"
    | "in_progress"
    | "success"
    | "failure"
    | "skipped"
    | "cancelled"
    | "indeterminate"
    | "missing";
  /** Why the row landed in its current status — "unchanged", "forced", etc. */
  reason?: string | null;
  errorMessage?: string | null;
  url?: string | null;
  checkRunUrl?: string | null;
}

export interface Deployment {
  id: string;
  /** Monotonic per-project version (v1, v2, …). Null for legacy rows. */
  version: number | null;
  /** `action_required` = failed on a named, clearable cause (see the API's
   *  blocking-errors module). Settled, like failed — not in flight. */
  status: "success" | "failed" | "building" | "pending" | "canceled" | "cancelled" | "partial_failure" | "action_required" | "rejected" | "reconciling";
  domain: string;
  framework: string;
  commit: {
    hash: string;
    fullHash?: string | null;
    message: string;
    author: string;
    timestamp: string;
    url?: string | null;
    changedFiles?: Array<{
      name: string;
      type: 'added' | 'modified' | 'removed';
      language?: string;
    }>;
  };
  buildTime: number | null;
  createdAt: string;
  type: string;
  environment: string;
  owner?: string;
  repo?: string;
  branch?: string;
  projectId?: string;
  projectName?: string;
  /** Auto-detected favicon of the deployed site, cached on the project.
   *  When present it replaces the framework/Docker glyph as the row logo. */
  favicon?: string | null;
  failureReason?: string;
  /** Rollback state — populated by the orchestrator-aware listing endpoint.
   *  `artifactRetainedAt` non-null = artifact is archived, rollback-eligible.
   *  `pinned` true = user-tagged to survive retention prune.
   *  `isActive` true = this is the project's active deployment right now. */
  artifactRetainedAt?: string | null;
  pinned?: boolean;
  isActive?: boolean;
  /**
   * Per-service deploy fan-out for this deployment. Populated when the
   * orchestrator-aware listing endpoint can resolve service_deployment
   * rows; omitted for single-app projects.
   */
  serviceDeployments?: ServiceDeploymentSummary[];
}

export interface Project {
  id: string;
  name: string;
}

export interface DeploymentStats {
  total: number;
  success: number;
  failed: number;
  building: number;
  pending?: number;
  canceled?: number;
}

