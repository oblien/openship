/**
 * Job service — the generic scheduled-task control plane.
 *
 * `reconcileJobs` is the single boot entrypoint (replaces the per-module
 * scheduleX calls): seed system-job rows from the registry, then register every
 * enabled job onto the shared runner. Editing a row (cron / enabled) re-syncs
 * just that job. `runJobNow` fires a job immediately, recorded as a manual run.
 */

import { repos, type Job } from "@repo/db";
import { nativeJobsEnabled, assertNativeJobs } from "../../native/execution-policy";
import { NotFoundError, ValidationError, safeErrorMessage, generateId } from "@repo/core";
import { getJobRunner } from "@repo/platform/engine/lib/job-runner/index";
import { scheduleSystemJob, recordJobRun, type JobSummary } from "@repo/platform/engine/lib/system-jobs";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { validateCronExpression } from "@repo/platform/engine/modules/backups/triggers/cron";
import { policyOrganizationId } from "@repo/platform/engine/modules/backups/backup.service";
import { SYSTEM_JOB_DEFS, SYSTEM_JOB_BY_KEY } from "@repo/platform/engine/modules/jobs/job.registry";
import { runCommandJobTick, startCommandRun } from "@repo/platform/engine/modules/jobs/job-command";
import { JOB_TRIGGER_EVENT_IDS, refreshTriggerArm } from "@repo/platform/engine/modules/jobs/job-events";
import { resolveServerIds, type CommandConfig, type JobNotifyConfig } from "@repo/platform/engine/modules/jobs/job.types";
import type { TCreateJobBody, TUpdateJobBody } from "@repo/contracts";

/** Resolve a job row's action. Builtin → the registry `run`; custom command
 *  execution is a later phase (returns null so it isn't scheduled/run yet). */
function resolveRun(row: Job): (() => Promise<JobSummary>) | null {
  if (row.actionType === "builtin") {
    return SYSTEM_JOB_BY_KEY.get(row.key)?.run ?? null;
  }
  return null;
}

export type SystemJobAvailability = "available" | "unavailable" | "unknown";

/** The registry is the sole source of truth for whether a built-in exists on
 * this platform. Keeping this check here lets every caller share the same gate
 * without creating a second scheduler or health-watch implementation. */
export function systemJobAvailability(key: string): SystemJobAvailability {
  const def = SYSTEM_JOB_BY_KEY.get(key);
  if (!def) return "unknown";
  return def.available && !def.available() ? "unavailable" : "available";
}

/** Ensure one registered system-job row exists. Safe to call concurrently with
 * boot reconciliation; the repository upsert converges on the unique job key
 * while preserving operator schedule/enabled overrides. */
export async function ensureSystemJob(key: string): Promise<Job> {
  const def = SYSTEM_JOB_BY_KEY.get(key);
  if (!def || systemJobAvailability(key) !== "available") {
    throw new NotFoundError("Job", key);
  }
  return repos.job.upsertSystem({
    key: def.key,
    label: def.label,
    defaultCron: def.defaultCron,
  });
}

/** Register or unregister a single job on the runner based on its current row.
 *  Only `recurring` jobs with a valid cron register on the runner; `once` jobs
 *  fire via the jobs:oneshot dispatcher and `manual` jobs only via Run-now /
 *  dependencies / event triggers. */
async function syncJob(row: Job): Promise<boolean> {
  if (!nativeJobsEnabled()) return false;
  const runner = await getJobRunner();
  // A row can survive a platform-mode change. It must never make a registered
  // built-in runnable somewhere its registry definition says it is unavailable.
  if (systemJobAvailability(row.key) === "unavailable") {
    await runner.removeRecurring(row.key);
    return false;
  }
  const recurring =
    row.enabled &&
    row.scheduleType === "recurring" &&
    !!row.cronExpression &&
    validateCronExpression(row.cronExpression).valid;
  if (!recurring) {
    await runner.removeRecurring(row.key);
    return false;
  }
  // Custom command jobs run their own streaming executor per tick (reads the
  // latest row so edits apply next fire); builtins use the recorded wrapper.
  if (row.actionType === "command") {
    await runner.scheduleRecurring({
      jobId: row.key,
      cronExpression: row.cronExpression!,
      onTick: async () => {
        try {
          await runCommandJobTick(row.key);
        } catch (err) {
          console.error(`[job] ${row.key} failed:`, safeErrorMessage(err));
        }
      },
    });
    return true;
  }
  const run = resolveRun(row);
  if (!run) {
    await runner.removeRecurring(row.key);
    return false;
  }
  await scheduleSystemJob({ jobId: row.key, cronExpression: row.cronExpression!, run });
  return true;
}

/**
 * Boot reconcile: seed the built-in system jobs (respecting operator cron /
 * enabled overrides), drop schedules for jobs no longer available on this
 * platform, then register every enabled job. Idempotent.
 */
export async function reconcileJobs(): Promise<{ registered: number; total: number }> {
  if (!nativeJobsEnabled()) return { registered: 0, total: 0 };
  const runner = await getJobRunner();

  for (const def of SYSTEM_JOB_DEFS) {
    if (systemJobAvailability(def.key) === "unavailable") {
      // Not applicable here (e.g. ssl:renew off self-hosted) — ensure it isn't
      // scheduled. The row (if any from a prior mode) is left but unscheduled.
      await runner.removeRecurring(def.key);
      continue;
    }
    await ensureSystemJob(def.key);
  }

  const jobs = await repos.job.listAll();
  let registered = 0;
  for (const row of jobs) {
    try {
      if (await syncJob(row)) registered++;
    } catch (err) {
      console.warn(`[jobs] failed to register ${row.key}: ${safeErrorMessage(err)}`);
    }
  }
  await refreshTriggerArm();
  return { registered, total: jobs.length };
}

export interface JobView extends Job {
  nextRunAt: Date | null;
  lastRun: Awaited<ReturnType<typeof repos.jobRun.listRecent>>[number] | null;
  recentRuns: Awaited<ReturnType<typeof repos.jobRun.listRecent>>;
}

/** Next scheduled fire: recurring → cron; once → runAt; manual → none. */
function computeNextRun(row: Job): Date | null {
  if (!row.enabled) return null;
  if (row.scheduleType === "once") return row.runAt ?? null;
  if (row.scheduleType === "recurring" && row.cronExpression) {
    return validateCronExpression(row.cronExpression).nextRunAt ?? null;
  }
  return null;
}

/** Never ship secret ciphertext to the client — expose only the secret KEYS
 *  (masked values) so the editor can show which secrets exist. */
function redactConfig(cfg: unknown): unknown {
  if (!cfg || typeof cfg !== "object") return cfg;
  const c = cfg as CommandConfig;
  if (!c.secrets) return cfg;
  return { ...c, secrets: Object.fromEntries(Object.keys(c.secrets).map((k) => [k, ""])) };
}

async function toView(row: Job, limit = 5): Promise<JobView> {
  const recentRuns = await repos.jobRun.listRecent({ jobId: row.key, limit });
  return {
    ...row,
    actionConfig: redactConfig(row.actionConfig),
    nextRunAt: computeNextRun(row),
    lastRun: recentRuns[0] ?? null,
    recentRuns,
  };
}

/** List all jobs with their next scheduled fire + recent run history. */
export async function listJobs(): Promise<JobView[]> {
  const jobs = await repos.job.listAll();
  return Promise.all(jobs.map((row) => toView(row)));
}

/** One job with its next fire + recent run history (detail page). */
export async function getJob(key: string): Promise<JobView> {
  const row = await repos.job.findByKey(key);
  if (!row) throw new NotFoundError("Job", key);
  return toView(row, 25);
}

// ─── Backup schedules (read-only surface) ────────────────────────────────────

/**
 * A scheduled backup policy, projected as a read-only "schedule" for the Jobs
 * tab. Backups keep their own scheduling (backups/triggers/cron.ts) + run model
 * on the SAME shared runner — this view only *surfaces* them alongside jobs so
 * operators see everything scheduled in one place. Managing them (create/edit/
 * run/delete) stays under each project's Backups tab; nothing here mutates.
 */
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
  nextRunAt: Date | null;
  lastRun: { id: string; status: string; startedAt: Date; finishedAt: Date | null } | null;
}

/**
 * Every enabled+scheduled backup policy in the caller's org, projected for the
 * Jobs view. Scoped by deriving the org from the policy's project (service
 * backups) or its destination (mail-server backups, which have no project) —
 * backup_policy has no org column of its own.
 */
export async function listBackupSchedules(
  organizationId: string,
): Promise<BackupScheduleView[]> {
  const policies = await repos.backupPolicy.listEnabledScheduled();
  const projectCache = new Map<string, Awaited<ReturnType<typeof repos.project.findById>>>();
  const destCache = new Map<string, Awaited<ReturnType<typeof repos.backupDestination.findById>>>();
  const serviceCache = new Map<string, Awaited<ReturnType<typeof repos.service.findById>>>();

  const out: BackupScheduleView[] = [];
  for (const p of policies) {
    if (!p.cronExpression) continue;

    // Org gate — reuse the backups module's authoritative derivation (project →
    // org for service backups, mail-server row → org for mail backups) so this
    // read view can't drift from how backups scope ownership. Gate first, then
    // load display rows only for policies this org owns.
    if ((await policyOrganizationId(p)) !== organizationId) continue;

    let project: Awaited<ReturnType<typeof repos.project.findById>> = undefined;
    if (p.projectId) {
      if (!projectCache.has(p.projectId)) projectCache.set(p.projectId, await repos.project.findById(p.projectId));
      project = projectCache.get(p.projectId);
    }
    let service: Awaited<ReturnType<typeof repos.service.findById>> = undefined;
    if (p.serviceId) {
      if (!serviceCache.has(p.serviceId)) serviceCache.set(p.serviceId, await repos.service.findById(p.serviceId));
      service = serviceCache.get(p.serviceId);
    }
    if (!destCache.has(p.destinationId)) destCache.set(p.destinationId, await repos.backupDestination.findById(p.destinationId));
    const dest = destCache.get(p.destinationId);

    const lastRun = await repos.backupRun.latestByPolicy(p.id);
    out.push({
      policyId: p.id,
      sourceKind: p.sourceKind,
      projectId: p.projectId,
      projectName: project?.name ?? null,
      serviceId: p.serviceId,
      serviceName: service?.name ?? null,
      mailServerId: p.mailServerId,
      payloadKind: p.payloadKind,
      destinationName: dest?.name ?? null,
      cronExpression: p.cronExpression,
      enabled: p.enabled,
      nextRunAt: validateCronExpression(p.cronExpression).nextRunAt ?? null,
      lastRun: lastRun
        ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt }
        : null,
    });
  }
  return out;
}

// ─── Custom-job config helpers ───────────────────────────────────────────────

/** Validate the schedule triple: recurring needs cron, once needs runAt. */
function validateSchedule(
  scheduleType: string,
  cronExpression?: string | null,
  runAt?: string | null,
): void {
  if (scheduleType === "recurring") {
    if (!cronExpression || !validateCronExpression(cronExpression).valid) {
      throw new ValidationError(`Invalid or missing cron expression: ${cronExpression ?? ""}`);
    }
  } else if (scheduleType === "once") {
    if (!runAt || Number.isNaN(Date.parse(runAt))) {
      throw new ValidationError("A valid run-at time is required for a one-time job");
    }
  }
}

function validateTriggerEvents(events?: string[]): void {
  for (const e of events ?? []) {
    if (!JOB_TRIGGER_EVENT_IDS.has(e)) throw new ValidationError(`Unknown trigger event: ${e}`);
  }
}

/** Reject dependency cycles (and unknown referenced jobs) via DFS over the
 *  current graph with the candidate's edges substituted in. */
async function assertDependencyGraphOk(key: string, dependsOn: string[]): Promise<void> {
  if (!dependsOn.length) return;
  const all = await repos.job.listAll();
  const graph = new Map<string, string[]>(all.map((j) => [j.key, j.dependsOn ?? []]));
  for (const dep of dependsOn) {
    if (dep !== key && !graph.has(dep)) throw new ValidationError(`Unknown dependency job: ${dep}`);
  }
  graph.set(key, dependsOn);
  const stack = new Set<string>();
  const done = new Set<string>();
  const dfs = (n: string): boolean => {
    if (stack.has(n)) return true;
    if (done.has(n)) return false;
    stack.add(n);
    for (const m of graph.get(n) ?? []) if (dfs(m)) return true;
    stack.delete(n);
    done.add(n);
    return false;
  };
  if (dfs(key)) throw new ValidationError("Dependency cycle detected");
}

/** Assemble the command actionConfig, encrypting secret values at rest. On
 *  update, missing fields fall back to the existing config; `secrets` (when
 *  present) is a full plaintext replacement map. */
function buildActionConfig(
  input: {
    serverId?: string;
    serverIds?: string[];
    command?: string;
    timeoutMs?: number;
    retry?: { maxAttempts: number; backoffSeconds: number };
    env?: Record<string, string>;
    secrets?: Record<string, string>;
  },
  existing?: CommandConfig,
): CommandConfig {
  const ids = resolveServerIds({
    serverId: input.serverId,
    serverIds: input.serverIds,
  });
  const serverIds = ids.length ? ids : existing?.serverIds ?? (existing?.serverId ? [existing.serverId] : []);
  if (!serverIds.length) throw new ValidationError("At least one target server is required");

  const secrets =
    input.secrets !== undefined
      ? Object.fromEntries(Object.entries(input.secrets).map(([k, v]) => [k, encrypt(v)]))
      : existing?.secrets;

  return {
    serverIds,
    serverId: serverIds[0],
    command: (input.command ?? existing?.command ?? "").trim(),
    ...(input.timeoutMs ?? existing?.timeoutMs ? { timeoutMs: input.timeoutMs ?? existing?.timeoutMs } : {}),
    ...(input.retry ?? existing?.retry ? { retry: input.retry ?? existing?.retry } : {}),
    ...(input.env ?? existing?.env ? { env: input.env ?? existing?.env } : {}),
    ...(secrets && Object.keys(secrets).length ? { secrets } : {}),
  };
}

/** Update a job. System jobs accept only cron/enabled; custom jobs accept the
 *  full config. Re-syncs the runner registration afterwards. */
export async function updateJob(key: string, patch: TUpdateJobBody): Promise<Job> {
  let row = await repos.job.findByKey(key);
  const advancedKeys = Object.keys(patch).filter(
    (k) => !["cronExpression", "enabled", "label"].includes(k),
  );
  // A registered built-in may be missing while the async boot reconciliation is
  // still running (or if that pass failed). PATCH is allowed to repair only that
  // known definition; arbitrary keys remain a 404. Validate before creating so
  // a rejected patch cannot leave behind an enabled-but-unscheduled row.
  if (!row) {
    if (systemJobAvailability(key) !== "available") throw new NotFoundError("Job", key);
    if (advancedKeys.length) {
      throw new ValidationError("System jobs only allow cron/enabled changes");
    }
    if (patch.cronExpression !== undefined && !validateCronExpression(patch.cronExpression).valid) {
      throw new ValidationError(`Invalid cron expression: ${patch.cronExpression}`);
    }
    row = await ensureSystemJob(key);
  }
  if (systemJobAvailability(key) === "unavailable") {
    throw new NotFoundError("Job", key);
  }

  // System jobs are code-defined — only schedule/enable are tunable.
  if (row.kind !== "custom" && advancedKeys.length) {
    throw new ValidationError("System jobs only allow cron/enabled changes");
  }

  if (patch.cronExpression !== undefined && !validateCronExpression(patch.cronExpression).valid) {
    throw new ValidationError(`Invalid cron expression: ${patch.cronExpression}`);
  }

  const set: Parameters<typeof repos.job.update>[1] = {};
  if (patch.label !== undefined) set.label = patch.label.trim();
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.cronExpression !== undefined) set.cronExpression = patch.cronExpression;

  if (row.kind === "custom") {
    const scheduleType = patch.scheduleType ?? row.scheduleType;
    if (patch.scheduleType !== undefined) set.scheduleType = patch.scheduleType;
    if (
      patch.scheduleType !== undefined ||
      patch.cronExpression !== undefined ||
      patch.runAt !== undefined
    ) {
      validateSchedule(
        scheduleType,
        patch.cronExpression ?? row.cronExpression,
        patch.runAt ?? (row.runAt ? row.runAt.toISOString() : null),
      );
      // Non-recurring jobs must not keep a stale cron on the row.
      if (scheduleType !== "recurring") set.cronExpression = null;
    }
    if (patch.runAt !== undefined) set.runAt = patch.runAt ? new Date(patch.runAt) : null;

    if (patch.dependsOn !== undefined) {
      await assertDependencyGraphOk(key, patch.dependsOn);
      set.dependsOn = patch.dependsOn;
    }
    if (patch.triggerEvents !== undefined) {
      validateTriggerEvents(patch.triggerEvents);
      set.triggerEvents = patch.triggerEvents;
    }
    if (patch.notifyConfig !== undefined) {
      set.notifyConfig = patch.notifyConfig as JobNotifyConfig | null;
    }

    const touchesConfig =
      patch.serverId !== undefined ||
      patch.serverIds !== undefined ||
      patch.command !== undefined ||
      patch.timeoutMs !== undefined ||
      patch.retry !== undefined ||
      patch.env !== undefined ||
      patch.secrets !== undefined;
    if (touchesConfig) {
      set.actionConfig = buildActionConfig(patch, (row.actionConfig ?? {}) as CommandConfig);
    }
  }

  await repos.job.update(key, set);
  const updated = (await repos.job.findByKey(key))!;
  await syncJob(updated);
  await refreshTriggerArm();
  return updated;
}

/**
 * Fire a job immediately (recorded as a manual run). Builtin jobs run inline and
 * return their summary; custom command jobs run in the BACKGROUND and return a
 * `runId` so the caller can subscribe to live logs (a long command must not
 * hold the HTTP request open).
 */
export async function runJobNow(
  key: string,
): Promise<{ key: string; summary?: JobSummary; runId?: string }> {
  assertNativeJobs();
  const row = await repos.job.findByKey(key);
  if (!row) throw new NotFoundError("Job", key);
  if (systemJobAvailability(key) === "unavailable") {
    throw new NotFoundError("Job", key);
  }
  if (row.actionType === "command") {
    const runId = await startCommandRun(row);
    return { key, runId };
  }
  const run = resolveRun(row);
  if (!run) throw new ValidationError(`Job "${key}" has no runnable action`);
  const summary = await recordJobRun(key, { trigger: "manual" }, run);
  return { key, summary };
}

/** Create a custom command job. Scheduled by cron (recurring), fired once at
 *  runAt, or manual-only; Run Now available anytime. */
export async function createCustomJob(
  input: TCreateJobBody & { createdBy?: string | null },
): Promise<Job> {
  if (!input.label.trim()) throw new ValidationError("A job name is required");
  if (!input.command.trim()) throw new ValidationError("A command is required");

  const scheduleType = input.scheduleType ?? "recurring";
  validateSchedule(scheduleType, input.cronExpression, input.runAt);
  validateTriggerEvents(input.triggerEvents);

  const key = `custom:${generateId()}`;
  if (input.dependsOn?.length) await assertDependencyGraphOk(key, input.dependsOn);

  const actionConfig = buildActionConfig(input);

  const row = await repos.job.create({
    key,
    kind: "custom",
    label: input.label.trim(),
    scheduleType,
    cronExpression: scheduleType === "recurring" ? input.cronExpression : null,
    runAt: scheduleType === "once" && input.runAt ? new Date(input.runAt) : null,
    enabled: true,
    actionType: "command",
    actionConfig,
    dependsOn: input.dependsOn ?? null,
    triggerEvents: input.triggerEvents ?? null,
    notifyConfig: (input.notifyConfig as JobNotifyConfig | undefined) ?? null,
    createdBy: input.createdBy ?? null,
  });
  await syncJob(row);
  await refreshTriggerArm();
  return row;
}

/** Delete a custom job (system jobs are code-defined and can't be removed). */
export async function deleteCustomJob(key: string): Promise<void> {
  const row = await repos.job.findByKey(key);
  if (!row) throw new NotFoundError("Job", key);
  if (row.kind !== "custom") {
    throw new ValidationError("System jobs can't be deleted; disable them instead.");
  }
  if (nativeJobsEnabled()) await (await getJobRunner()).removeRecurring(key);
  await repos.job.remove(key);
  await refreshTriggerArm();
}
