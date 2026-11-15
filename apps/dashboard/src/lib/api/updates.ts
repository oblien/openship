import { api } from "./client";
import { endpoints } from "./endpoints";
import type {
  CreateDeploymentResult,
  ProjectUpdate,
  UpdateRuntimeInput,
  RuntimeImageCheckResult,
  ProjectSecurityResult,
  AdvisoryFeedResult,
  ApplySecurityInput,
  SecurityCheckPolicy,
  RuntimeSourceInput,
  RuntimeSourceEdit,
  RuntimeSource,
  RuntimeSourcePreview,
  PublishRuntimeSourceInput,
  PublishedRepositoryChange,
} from "@repo/contracts";

/** One entity's update status (project/app/self-app/webmail). */
export type UpdateStatusItem = ProjectUpdate;

export interface ScanSummary {
  scanned: number;
  supported: number;
}

export const updatesApi = {
  runtimeSource: (projectId: string, input: RuntimeSourceInput) =>
    api.post<{ data: RuntimeSource }>(
      `/updates/${encodeURIComponent(projectId)}/runtime/source`,
      input,
    ),
  previewRuntimeSource: (projectId: string, input: RuntimeSourceEdit) =>
    api.post<{ data: RuntimeSourcePreview }>(
      `/updates/${encodeURIComponent(projectId)}/runtime/source/preview`,
      input,
    ),
  publishRuntimeSource: (projectId: string, input: PublishRuntimeSourceInput) =>
    api.post<{ data: PublishedRepositoryChange }>(
      `/updates/${encodeURIComponent(projectId)}/runtime/source/publish`,
      input,
      { timeout: 60_000 },
    ),
  securityCheckPolicy: () =>
    api.get<{ data: SecurityCheckPolicy }>("/updates/security/policy"),
  setSecurityCheckPolicy: (checksEnabled: boolean) =>
    api.put<{ data: SecurityCheckPolicy }>(
      "/updates/security/policy", { checksEnabled },
    ),
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
