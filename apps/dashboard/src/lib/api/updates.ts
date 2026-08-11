import { api } from "./client";
import { endpoints } from "./endpoints";

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
