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
  checkedAt: string;
}

export interface ScanSummary {
  scanned: number;
  supported: number;
  behind: number;
}

export const updatesApi = {
  /** All cached update statuses for the org (optionally only those behind). */
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
