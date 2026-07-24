import { api } from "./client";
import { endpoints } from "./endpoints";

export type MonitorStatus = "unknown" | "up" | "down";

export interface Monitor {
  id: string;
  organizationId: string;
  projectId: string;
  createdBy: string | null;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number | null;
  failureThreshold: number;
  enabled: boolean;
  status: MonitorStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  /** Uptime percentage over the last 24h, computed from monitor_check rows.
   *  Only the list endpoint computes it — absent on create/update responses. */
  uptime24h?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorCheck {
  id: string;
  monitorId: string;
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
}

export interface MonitorIncident {
  id: string;
  monitorId: string;
  organizationId: string;
  projectId: string;
  startedAt: string;
  resolvedAt: string | null;
  error: string | null;
  failedChecks: number;
}

/* ── API client ──────────────────────────────────────────────────── */

export const monitorsApi = {
  list: (projectId: string | number) =>
    api.get<{ data: Monitor[] }>(endpoints.projects.monitors(projectId)),

  create: (
    projectId: string | number,
    data: {
      name: string;
      url: string;
      intervalSeconds?: number;
      timeoutMs?: number;
      expectedStatus?: number | null;
      failureThreshold?: number;
    },
  ) => api.post<{ data: Monitor }>(endpoints.projects.monitors(projectId), data),

  update: (
    projectId: string | number,
    monitorId: string,
    data: Partial<{
      name: string;
      url: string;
      intervalSeconds: number;
      timeoutMs: number;
      expectedStatus: number | null;
      failureThreshold: number;
      enabled: boolean;
    }>,
  ) => api.patch<{ data: Monitor }>(endpoints.projects.monitor(projectId, monitorId), data),

  delete: (projectId: string | number, monitorId: string) =>
    api.delete<{ success: boolean }>(endpoints.projects.monitor(projectId, monitorId)),

  listChecks: (projectId: string | number, monitorId: string, hours?: number) => {
    const base = endpoints.projects.monitorChecks(projectId, monitorId);
    const url = hours ? `${base}?hours=${hours}` : base;
    return api.get<{ data: MonitorCheck[] }>(url);
  },

  listIncidents: (projectId: string | number, monitorId: string) =>
    api.get<{ data: MonitorIncident[] }>(endpoints.projects.monitorIncidents(projectId, monitorId)),
};
