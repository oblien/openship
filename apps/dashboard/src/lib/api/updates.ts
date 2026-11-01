import { api } from "./client";
import { endpoints } from "./endpoints";
import type {
  CreateDeploymentResult,
  UpdateRuntimeInput,
  RuntimeImageCheckResult,
  ProjectSecurityResult,
  AdvisoryFeedResult,
  ApplySecurityInput,
} from "@repo/contracts";

/** One entity's update status (project/app/self-app/webmail). */
export interface UpdateStatusItem {
  projectId: string;
  name: string;
  slug: string | null;
  isApp: boolean;
  appTemplateId: string | null;
  kind: "commit" | "release" | "image";
  behind: boolean;
  latestInProgress: boolean;
  inProgressDeploymentId?: string | null;
  currentLabel: string | null;
  latestLabel: string | null;
  detail: unknown;
  /** When the UPSTREAM side was last polled. `behind` itself is computed live. */
  checkedAt: string;
}

export interface ScanSummary {
  scanned: number;
  supported: number;
}

export const updatesApi = {
  checkSecurity: (projectId: string) =>
    api.post<{ data: ProjectSecurityResult }>(
      `/updates/${encodeURIComponent(projectId)}/security/check`,
      undefined,
      { timeout: 60_000 },
    ),
  advisories: () =>
    api.get<{ data: AdvisoryFeedResult }>("/updates/advisories", { timeout: 60_000 }),
  security: (projectId: string) =>
    api.get<{ data: ProjectSecurityResult }>(`/updates/${encodeURIComponent(projectId)}/security`, {
      timeout: 60_000,
    }),
  securityPolicy: (projectId: string, autoRefresh: boolean) =>
    api.put<{ data: { autoRefresh: boolean } }>(
      `/updates/${encodeURIComponent(projectId)}/security/policy`,
      { autoRefresh },
    ),
  applySecurity: (projectId: string, input: ApplySecurityInput) =>
    api.post<{ data: CreateDeploymentResult }>(
      `/updates/${encodeURIComponent(projectId)}/security/apply`,
      input,
      { timeout: 60_000 },
    ),
  checkRuntime: (projectId: string, input: UpdateRuntimeInput = {}) =>
    api.post<{ data: RuntimeImageCheckResult }>(endpoints.updates.runtimeCheck(projectId), input, {
      timeout: 60_000,
    }),
  /** Refresh configured runtime tags/base images without changing source or pins. */
  updateRuntime: (projectId: string, input: UpdateRuntimeInput = {}) =>
    api.post<{ data: CreateDeploymentResult }>(endpoints.updates.runtime(projectId), input, {
      timeout: 60_000,
    }),

  /**
   * Every project with a drift question, whether or not a scan has run — the read
   * is read-through server-side, so an absent entry means "nothing to compare"
   * (never deployed, no remote source), not "not checked yet".
   */
  list: (behindOnly = false) =>
    api.get<{ data: UpdateStatusItem[] }>(
      behindOnly ? endpoints.updates.behind : endpoints.updates.list,
    ),

  /** Force a fresh scan across the org. */
  scan: () => api.post<{ data: ScanSummary }>(endpoints.updates.scan),

  /** Apply the available update to a project/app (force-pull + redeploy). */
  apply: (projectId: string) =>
    api.post<{ data: { success: boolean; deployment_id: string; project_id: string } }>(
      endpoints.updates.apply(projectId),
    ),
};
