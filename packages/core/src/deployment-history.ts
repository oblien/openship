/** Status groups used by deployment history filters across transports. */
export const DEPLOYMENT_HISTORY_STATUSES = {
  success: ["ready", "no_changes"],
  failed: ["failed", "action_required", "partial_failure", "rejected"],
  building: ["building", "deploying", "reconciling"],
  pending: ["queued"],
  canceled: ["cancelled"],
  active: ["building", "deploying", "reconciling", "queued"],
} as const;

export type DeploymentHistoryFilter = keyof typeof DEPLOYMENT_HISTORY_STATUSES;
export interface DeploymentHistoryQuery {
  /** UTC calendar days including today; also returns an unpaginated summary. */
  days?: number;
  page?: number;
  perPage?: number;
  environment?: string;
  status?: DeploymentHistoryFilter;
  search?: string;
}

export interface DeploymentOutcomeCounts {
  total: number;
  success: number;
  failed: number;
  active: number;
  canceled: number;
}
export interface DeploymentHistorySummary extends DeploymentOutcomeCounts {
  days: number;
  avgBuildDurationMs: number | null;
  daily: Array<DeploymentOutcomeCounts & { date: string }>;
  projects: Array<DeploymentOutcomeCounts & { projectId: string }>;
}

export function summarizeDeploymentHistory(
  rows: Array<{
    date: string;
    projectId: string;
    status: string;
    count: number;
    buildMs: number;
    builds: number;
  }>,
  days: number,
  now = new Date(),
): DeploymentHistorySummary {
  const empty = (): DeploymentOutcomeCounts => ({
    total: 0,
    success: 0,
    failed: 0,
    active: 0,
    canceled: 0,
  });
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - days + 1 + i);
    return { date: date.toISOString().slice(0, 10), ...empty() };
  });
  const projects = new Map<string, DeploymentOutcomeCounts & { projectId: string }>();
  const summary: DeploymentHistorySummary = {
    ...empty(),
    days,
    avgBuildDurationMs: null,
    daily,
    projects: [],
  };
  let buildMs = 0;
  let builds = 0;
  for (const row of rows) {
    const day = daily.find((d) => d.date === row.date);
    if (!day) continue;
    const project = projects.get(row.projectId) ?? { projectId: row.projectId, ...empty() };
    projects.set(row.projectId, project);
    const group = Object.entries(DEPLOYMENT_HISTORY_STATUSES).find(([, statuses]) =>
      (statuses as readonly string[]).includes(row.status),
    )?.[0];
    for (const target of [summary, day, project]) {
      target.total += Number(row.count);
      if (group === "success" || group === "failed" || group === "canceled")
        target[group] += Number(row.count);
      if (group === "building" || group === "pending") target.active += Number(row.count);
    }
    buildMs += Number(row.buildMs);
    builds += Number(row.builds);
  }
  summary.avgBuildDurationMs = builds ? Math.round(buildMs / builds) : null;
  summary.projects = [...projects.values()].sort(
    (a, b) =>
      b.failed - a.failed ||
      b.active - a.active ||
      b.total - a.total ||
      a.projectId.localeCompare(b.projectId),
  );
  return summary;
}
