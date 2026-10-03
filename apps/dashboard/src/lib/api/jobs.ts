import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

/** One execution of a job (from job_run). Dates are ISO strings. */
export interface JobRunSummary {
  id: string;
  jobId: string;
  kind: string;
  trigger: "schedule" | "manual" | "once" | "dependency" | "event" | string;
  status: "running" | "success" | "failed" | string;
  /** Target server for this run (multi-server jobs); null otherwise. */
  serverId: string | null;
  /** Retry attempt number (1-based). */
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: Record<string, unknown> | null;
  /** Captured command output (custom jobs); stored on finish. */
  output?: string | null;
  error: string | null;
}

export interface JobRetryConfig {
  maxAttempts: number;
  backoffSeconds: number;
}

/** Custom-job action config (secrets are returned with masked values). */
export interface JobActionConfig {
  serverId?: string;
  serverIds?: string[];
  command?: string;
  timeoutMs?: number;
  retry?: JobRetryConfig;
  env?: Record<string, string>;
  /** Keys only — values are masked ("") on read. */
  secrets?: Record<string, string>;
}

export type JobRunState = "running" | "success" | "failed";

export interface JobNotifyConfig {
  channels: string[];
  states: JobRunState[];
}

/** A scheduled job definition + its next fire and recent run history. */
export interface JobView {
  id: string;
  key: string;
  kind: "system" | "custom" | string;
  label: string;
  cronExpression: string | null;
  scheduleType: "recurring" | "once" | "manual" | string;
  runAt: string | null;
  enabled: boolean;
  actionType: string;
  actionConfig: JobActionConfig | null;
  dependsOn: string[] | null;
  triggerEvents: string[] | null;
  notifyConfig: JobNotifyConfig | null;
  nextRunAt: string | null;
  lastRun: JobRunSummary | null;
  recentRuns: JobRunSummary[];
}

export interface JobTriggerEvent {
  id: string;
  label: string;
  description: string;
}

/** A scheduled backup policy, surfaced read-only in the Jobs view. Managed
 *  under each project's Backups tab — this is display-only. */
export interface BackupScheduleView {
  policyId: string;
  sourceKind: string;
  projectId: string | null;
  projectName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  mailServerId: string | null;
  payloadKind: string;
  destinationName: string | null;
  cronExpression: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRun: { id: string; status: string; startedAt: string; finishedAt: string | null } | null;
}

/** Update payload from the shared job contract. */
export type JobInput = import("@repo/contracts").UpdateJobInput;

export const jobsApi = {
  /** List jobs visible to the current organization and server permissions. */
  list: () => api.get<{ data: JobView[] }>(endpoints.jobs.list),

  /** One job with next run + recent run history. */
  get: (key: string) => api.get<{ data: JobView }>(endpoints.jobs.detail(key)),

  /** A job's run history. */
  listRuns: (key: string, limit = 50) =>
    api.get<{ data: JobRunSummary[] }>(`${endpoints.jobs.runs(key)}?limit=${limit}`),

  /** Curated list of events a job can be triggered on. */
  triggerEvents: () =>
    api.get<{ data: JobTriggerEvent[] }>(endpoints.jobs.triggerEvents),

  /** Read-only backup policy schedules for the active org (surfaced in Jobs). */
  backupSchedules: () =>
    api.get<{ data: BackupScheduleView[] }>(endpoints.jobs.backupSchedules),

  /** Create a custom command job. */
  create: (body: import("@repo/contracts").CreateJobInput) => api.post<{ data: JobView }>(endpoints.jobs.list, body),

  /** Update a job (cron/enabled for any; full config for custom jobs). */
  update: (key: string, body: JobInput) =>
    api.patch<{ data: JobView }>(endpoints.jobs.update(key), body),

  /** Delete a custom job (system jobs can't be removed). */
  remove: (key: string) => api.delete<{ success: boolean }>(endpoints.jobs.update(key)),

  /** Run a job now. Builtin → { summary }; custom → { runId } (stream its logs). */
  run: (key: string) =>
    api.post<{ data: { key: string; summary?: Record<string, unknown> | null; runId?: string } }>(
      endpoints.jobs.run(key),
    ),

  /** Fetch one run incl. its captured output (history detail). */
  getRun: (runId: string) => api.get<{ data: JobRunSummary }>(endpoints.jobs.runDetail(runId)),

  /** Absolute URL of a run's live-log SSE stream (for connectToSSE). */
  runStreamUrl: (runId: string) =>
    `${getApiBaseUrl().replace(/\/$/, "")}/${endpoints.jobs.runStream(runId)}`,
};
