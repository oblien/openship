import { createHash } from "node:crypto";
import { startWorkflowJob, workflowJobRuns } from "./job-workflow";
import { workflowJobConfig } from "./job.types";
/**
 * Custom (command) job execution.
 *
 * A custom job runs a shell command — which may be `docker run --rm <image>
 * <cmd>` — on one or more connected or managed servers, streaming each
 * output line to the job-run SSE bus and storing captured output on the row.
 * Reuses the shared server connection and streamExec primitive.
 *
 * Advanced policies handled here:
 *   - timeout    aborts the executor stream and awaits settlement before releasing
 *                its connection or starting the next attempt.
 *   - retry      up to maxAttempts into ONE aggregate run row (attempts append
 *                to its output + are counted in summary.attempts), backoffSeconds
 *                between — so run-now's returned run id + its SSE stream span
 *                every attempt to the final outcome.
 *   - env/secrets  merged + shell-quoted `export`s prepended (secrets decrypted
 *                  at run time; never stored or logged in plaintext).
 *   - multi-server  fan out across servers in parallel within one run, each
 *                   line prefixed [server]; status = failed if any server fails.
 *   - notifications  emit on running/success/failed (per-job override or global).
 *   - dependencies   on success, fire jobs whose dependsOn is now all-green.
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics, reportError } from "@repo/core/diagnostics";
import { enrichErrorContext } from "@repo/core/diagnostics/node";
import { repos, type Job, type JobRun } from "@repo/db";
import { deferBackgroundWork } from "../../lib/background-work";
import { assertNativeJobs } from "../../native/execution-policy";
import { AppError, NotFoundError, safeErrorMessage } from "@repo/core";
import { OperationError } from "@repo/contracts";
import type { LogEntry } from "@repo/adapters";
import { withServerExecution } from "../../lib/server-execution";
import { env } from "../../config";
import { assertManagedServerCanWork } from "../../lib/cloud-workspace-access";
import { decryptEnvMap } from "../../lib/encryption";
import { notification } from "../../lib/notification-dispatcher";
import { jobRunBus } from "./job-run.sse";
import { boundedStorableText } from "../deployments/build-log-sanitize";
import {
  resolveServerIds,
  jobTargetsOrganization,
  type CommandConfig,
  type JobNotifyConfig,
  type JobRunState,
} from "./job.types";

/** Cap stored output so a chatty command can't bloat the row. */
const MAX_OUTPUT = 200_000;
const MAX_ERROR = 4_096;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Stand-in when the captured text is the reason the row won't write. */
const OUTPUT_UNSTORABLE =
  "[output omitted — the captured command output could not be stored; see server logs]";
const ERROR_UNSTORABLE = "Command failed (details could not be stored; see server logs)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server a run row is tagged with: the single target, or null when the
 *  job fans out across several (the run is then an aggregate). */
function primaryServerId(cfg: CommandConfig): string | null {
  const ids = resolveServerIds(cfg);
  return ids.length === 1 ? ids[0] : null;
}

/** Single-quote a value for a POSIX shell (escaping embedded quotes). */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Prepend `export K='v';` for each (valid-identifier) env var. */
function buildCommand(cfg: CommandConfig): string {
  const merged = { ...(cfg.env ?? {}), ...decryptEnvMap(cfg.secrets ?? {}) };
  const exports = Object.entries(merged)
    .filter(([k]) => VALID_ENV_KEY.test(k))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("; ");
  const command = (cfg.command ?? "").trim();
  return exports ? `${exports}; ${command}` : command;
}

async function commandTargets(cfg: CommandConfig) {
  const ids = resolveServerIds(cfg);
  const servers = await repos.server.getMany(ids);
  const organizationId = jobTargetsOrganization(ids, servers);
  if (!organizationId || ids.some(id => !servers.has(id) || (env.CLOUD_MODE && !servers.get(id)?.workspaceId)))
    throw new NotFoundError("Job target server");
  return { organizationId, servers: ids.map(id => servers.get(id)!) };
}

/** Check every target before starting any command, including every retry. */
async function assertCommandTargetsReady(cfg: CommandConfig, expectedOrganizationId?: string) {
  const targets = await commandTargets(cfg);
  if (expectedOrganizationId && targets.organizationId !== expectedOrganizationId)
    throw new NotFoundError("Job target server");
  for (const server of targets.servers) {
    if (!server.workspaceId) continue;
    try {
      await assertManagedServerCanWork(targets.organizationId, server.workspaceId);
    } catch (error) {
      if (error instanceof AppError && error.code === "CLOUD_BILLING_BLOCKED")
        throw new OperationError(error.message, error.statusCode, error.code, { workspaceId: server.workspaceId, serverId: server.id });
      throw error;
    }
  }
  return targets;
}

/** Run the command on one server, holding the pooled connection for the run. */
async function runOnServer(
  organizationId: string,
  serverId: string,
  command: string,
  onLine: (entry: LogEntry) => void,
  timeoutMs?: number,
): Promise<{ code: number; output: string }> {
  const abort = new AbortController();
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : undefined;
  try {
    const result = await withServerExecution(organizationId, serverId, executor => {
      abort.signal.throwIfAborted();
      return executor.streamExec(command, onLine, { signal: abort.signal });
    }, { mutation: true, scope: "job" });
    if (abort.signal.aborted) throw new Error(`Command timed out after ${timeoutMs}ms`);
    return result;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`Command timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Execute ONE attempt, streaming each line to `streamId` (the stable aggregate
 *  run id), fanning out across servers if configured. Returns the attempt's
 *  status + captured output; does NOT finish the row or publish `complete` —
 *  runLoop owns the single aggregate run so one id + one SSE stream span every
 *  retry. Never throws. */
async function executeAttempt(
  cfg: CommandConfig,
  streamId: string,
  organizationId: string | null,
): Promise<{ status: JobRunState; output: string; error?: string; exitCode?: number }> {
  const publish = (line: string, level: LogEntry["level"]) =>
    jobRunBus.publish(streamId, { type: "log", line, level });
  try {
    const servers = resolveServerIds(cfg);
    if (!servers.length || !cfg.command?.trim()) {
      throw new Error("Custom job is missing a target server or command.");
    }
    if (!organizationId) throw new NotFoundError("Job target server");
    await assertCommandTargetsReady(cfg, organizationId);
    const command = buildCommand(cfg);

    let code: number | null;
    let output: string;
    if (servers.length === 1) {
      const r = await runOnServer(organizationId, servers[0], command, (e) => publish(e.message, e.level), cfg.timeoutMs);
      output = r.output;
      code = r.code;
    } else {
      const results = await Promise.all(
        servers.map(async (sid) => {
          try {
            const r = await runOnServer(organizationId, sid, command, (e) => publish(`[${sid}] ${e.message}`, e.level), cfg.timeoutMs);
            return { sid, code: r.code, output: r.output };
          } catch (err) {
            observeCaughtError(err, "platform/engine/modules/jobs/job-command");
            const msg = safeErrorMessage(err);
            publish(`[${sid}] ${msg}`, "error");
            return { sid, code: null, output: msg };
          }
        }),
      );
      const firstFailure = results.find((r) => r.code !== 0);
      code = firstFailure ? firstFailure.code : 0;
      output = results.map((r) => `── ${r.sid} (exit ${r.code ?? "unknown"}) ──\n${r.output}`).join("\n\n");
    }

    return code === 0
      ? { status: "success", output, exitCode: 0 }
      : {
          status: "failed",
          output,
          exitCode: code ?? undefined,
          error: code === null ? "Command failed without an exit status" : `Command exited with code ${code}`,
        };
  } catch (err) {
    observeCaughtError(err, "platform/engine/modules/jobs/job-command");
    const message = safeErrorMessage(err);
    publish(message, "error");
    return { status: "failed", output: message, error: message };
  }
}

/** Run a job with retries into the SINGLE run row `run`: emit `running`, execute
 *  attempts (all streaming to the same run id), finish the row ONCE with the
 *  final status + aggregated output + attempt count, publish one terminal
 *  `complete`, emit the terminal state, then fire dependents. The run id is
 *  stable across retries, so run-now's caller + its SSE stream follow through to
 *  the final outcome. */
async function runLoop(row: Job, run: JobRun): Promise<void> {
  const cfg = (row.actionConfig ?? {}) as CommandConfig;
  const maxAttempts = Math.max(1, cfg.retry?.maxAttempts ?? 1);
  const backoffMs = Math.max(0, (cfg.retry?.backoffSeconds ?? 0) * 1000);
  const startedMs = Date.now();
  const organizationId = await commandTargets(cfg).then(targets => targets.organizationId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/jobs/job-command"); return null; });

  await emitJobRun(row, run.id, "running", organizationId);
  enrichErrorContext({ jobId: row.key, runId: run.id, organizationId: organizationId ?? undefined });

  let finalStatus: JobRunState = "failed";
  let exitCode: number | undefined;
  let lastError: string | undefined;
  let attemptsUsed = 0;
  const chunks: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    if (attempt > 1) {
      const marker = `── retry ${attempt}/${maxAttempts} ──`;
      jobRunBus.publish(run.id, { type: "log", line: marker, level: "info" });
      chunks.push(marker);
    }
    const res = await executeAttempt(cfg, run.id, organizationId);
    chunks.push(res.output);
    exitCode = res.exitCode;
    if (res.status === "success") {
      finalStatus = "success";
      exitCode = 0;
      lastError = undefined;
      break;
    }
    lastError = res.error;
    if (attempt < maxAttempts && backoffMs) await sleep(backoffMs);
  }

  const durationMs = Date.now() - startedMs;
  if (finalStatus === "failed") reportError(lastError ?? "Job command failed", {
    kind: "background", component: "job-command", jobId: row.key, runId: run.id,
    organizationId: organizationId ?? undefined, durationMs, attempt: attemptsUsed, handled: true,
  });
  await finishRunRow(run.id, row.key, {
    status: finalStatus,
    durationMs,
    summary: { exitCode, attempts: attemptsUsed },
    output: boundedStorableText(chunks.join("\n"), MAX_OUTPUT),
    error:
      finalStatus === "failed"
        ? boundedStorableText(lastError ?? "Command failed", MAX_ERROR)
        : undefined,
  });
  try {
    jobRunBus.publish(run.id, { type: "complete", status: finalStatus, error: lastError });
  } catch (err) {
    errorDiagnostics.error("platform/engine/modules/jobs/job-command",
      `[job] ${row.key} run ${run.id}: terminal SSE publish failed: ${safeErrorMessage(err)}`, err,
    );
  }

  await emitJobRun(row, run.id, finalStatus, organizationId, {
    durationMs,
    exitCode,
    error: lastError ? boundedStorableText(lastError, MAX_ERROR) : undefined,
    output: chunks.join("\n"),
  });
  if (finalStatus === "success" && organizationId) await fireDependents(row.key, organizationId, run.id);
}

type FinishData = {
  status: "success" | "failed";
  durationMs: number;
  summary: Record<string, unknown>;
  output: string;
  error?: string;
};

/**
 * Close the run row without ever letting its OUTPUT strand it at "running".
 *
 * `output`/`error` are raw remote command bytes and `job_run.output` is a text
 * column: a NUL makes the UPDATE throw, and that throw used to precede the
 * terminal `complete` SSE event, the notification, and the dependency fan-out —
 * so the row sat "running" forever, the stream never closed, and dependents
 * never fired. The outcome is therefore retried with progressively less payload
 * until the row is terminal; only a dead database can defeat all three.
 */
async function finishRunRow(runId: string, jobKey: string, data: FinishData): Promise<void> {
  const attempts: FinishData[] = [
    data,
    { ...data, output: OUTPUT_UNSTORABLE },
    {
      status: data.status,
      durationMs: data.durationMs,
      summary: data.summary,
      output: OUTPUT_UNSTORABLE,
      error: data.status === "failed" ? ERROR_UNSTORABLE : undefined,
    },
  ];
  for (const attempt of attempts) {
    try {
      await repos.jobRun.finish(runId, attempt);
      return;
    } catch (err) {
      errorDiagnostics.error("platform/engine/modules/jobs/job-command",
        `[job] ${jobKey} run ${runId}: finish write rejected: ${safeErrorMessage(err)}`, err,
      );
    }
  }
  errorDiagnostics.error("platform/engine/modules/jobs/job-command",
    `[job] ${jobKey} run ${runId}: could not record the terminal status — the row is left "running" for the boot sweep to reconcile`,
  );
}

/** Scheduled tick — awaited (inside a runner timer). Reads the latest row so
 *  edits take effect on the next fire. */
export async function runCommandJobTick(key: string): Promise<void> {
  assertNativeJobs();
  const row = await repos.job.findByKey(key);
  if (!row || !row.enabled || row.actionType !== "command" || row.scheduleType !== "recurring") return;
  const cfg = (row.actionConfig ?? {}) as CommandConfig;
  const single = primaryServerId(cfg);
  const run = await repos.jobRun.start({ jobId: key, kind: "custom", trigger: "schedule", serverId: single, serverIds: resolveServerIds(cfg) });
  await runLoop(row, run);
}

/** Fire a job now (or via dependency/event/once). Opens the first run row, kicks
 *  the retry loop in the background, and returns that run id for live logs. */
export async function startCommandRun(
  row: Job,
  trigger: "manual" | "dependency" | "event" | "once" = "manual",
  identity?: string,
): Promise<string> {
  assertNativeJobs();
  const cfg = (row.actionConfig ?? {}) as CommandConfig;
  if (trigger === "manual") await assertCommandTargetsReady(cfg);
  const single = primaryServerId(cfg);
  const input = { jobId: row.key, kind: "custom", trigger, serverId: single, serverIds: resolveServerIds(cfg) };
  const receipt = identity ? `jrun_${createHash("sha256").update(`${row.key}:${row.updatedAt.toISOString()}:${identity}`).digest("hex")}` : undefined;
  const run = receipt ? await repos.jobRun.startOnce(input, receipt) : await repos.jobRun.start(input);
  if (!run) return receipt!;
  void deferBackgroundWork(() => runLoop(row, run)).catch((err) =>
      errorDiagnostics.error("platform/engine/modules/jobs/job-command", `[job] ${row.key} run failed:`, safeErrorMessage(err), err),
  );
  return run.id;
}

/** Fire any `once` jobs whose runAt is due, then disable them (system job
 *  jobs:oneshot ticks this every minute — the runner has no delayed schedule). */
export async function runDueOnceJobs(): Promise<{ fired: number }> {
  const now = Date.now();
  const jobs = await repos.job.listAll();
  let fired = 0;
  for (const job of jobs) {
    if (job.scheduleType !== "once" || !job.enabled || !["command", "workflow"].includes(job.actionType)) continue;
    if (!job.runAt || job.runAt.getTime() > now) continue;
    if (job.actionType === "workflow") await startWorkflowJob(job, "once");
    else await startCommandRun(job, "once");
    await repos.job.update(job.key, { enabled: false, runAt: null });
    fired++;
  }
  return { fired };
}

// ─── Notifications ───────────────────────────────────────────────────────────

const STATE_EVENT: Record<JobRunState, string> = {
  running: "job_run.started",
  success: "job_run.succeeded",
  failed: "job_run.failed",
};

const MAX_NOTIFY_LOG_LINES = 20;
const MAX_NOTIFY_LOG_CHARS = 2000;

function extractLogExcerpt(output?: string): string | undefined {
  if (!output) return undefined;
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split("\n");
  const tail = boundedStorableText(lines.slice(-MAX_NOTIFY_LOG_LINES).join("\n"), Number.MAX_SAFE_INTEGER);
  if (tail.length <= MAX_NOTIFY_LOG_CHARS) return tail;
  return boundedStorableText(`…\n${tail.slice(-(MAX_NOTIFY_LOG_CHARS - 2))}`, MAX_NOTIFY_LOG_CHARS);
}

/** Notify on a run state. Per-job `notifyConfig` (if present) OVERRIDES the
 *  global Settings subscriptions — its channels/states win, no double-fire. */
export async function emitJobRun(
  row: Pick<Job, "key" | "label" | "notifyConfig">,
  runId: string,
  status: JobRunState,
  organizationId: string | null,
  meta?: {
    durationMs?: number;
    exitCode?: number;
    error?: string;
    output?: string;
  },
): Promise<void> {
  if (!organizationId) return;
  try {
    const logExcerpt = extractLogExcerpt(meta?.output);
    const payload: Record<string, unknown> = {
      label: row.label,
      jobName: row.label,
      jobKey: row.key,
      status,
      runId,
      ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta?.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
      ...(meta?.error ? { errorMessage: meta.error } : {}),
      ...(logExcerpt ? { logExcerpt } : {}),
    };
    const notify = row.notifyConfig as JobNotifyConfig | null;

    if (notify?.channels?.length) {
      if (!notify.states?.includes(status)) return;
      for (const channelId of notify.channels) {
        const channel = await repos.notificationChannel.findById(channelId);
        if (!channel || !channel.enabled || !channel.verified) continue;
        if (!(await repos.member.isMember(organizationId, channel.userId))) continue;
        await repos.notificationDelivery.create({
          userId: channel.userId,
          organizationId,
          auditEventId: null,
          category: `job.run.${status === "success" ? "succeeded" : status === "failed" ? "failed" : "started"}`,
          channelId: channel.id,
          channelKind: channel.kind,
          status: "queued",
          attempts: 0,
          payload,
        });
      }
      return;
    }

    // Global: route through the dispatcher (maps eventType → category → subs).
    notification.emit({
      organizationId,
      eventType: STATE_EVENT[status],
      resourceType: "job",
      resourceId: row.key,
      payload,
    });
  } catch (err) {
    errorDiagnostics.warn("platform/engine/modules/jobs/job-command", `[job] notify failed for ${row.key}: ${safeErrorMessage(err)}`, err);
  }
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/** On a job's success, fire any enabled job that depends on it — but only once
 *  ALL of that dependent's dependencies are currently green. Cycles are
 *  rejected at create/update time, so this terminates. */
export async function fireDependents(jobKey: string, organizationId: string, sourceRunId?: string): Promise<void> {
  // The calling controller owns reporting and recovery. A dispatch failure must
  // keep an Actions run unsettled; retries reuse each dependent's run identity.
  const jobs = await repos.job.listAll();
  const ids = new Map(jobs.map(job => [job.key, resolveServerIds((job.actionConfig ?? {}) as CommandConfig)]));
  const servers = await repos.server.getMany([...new Set([...ids.values()].flat())]);
  const owner = (row: Job) => workflowJobConfig(row)?.authority.organizationId ?? jobTargetsOrganization(ids.get(row.key) ?? [], servers);
  for (const dep of jobs) {
    if (!dep.enabled || !["command", "workflow"].includes(dep.actionType)) continue;
    if (owner(dep) !== organizationId) continue;
    const deps = dep.dependsOn ?? [];
    if (!deps.includes(jobKey)) continue;
    const greens = await Promise.all(
      deps.map(async (k) => {
        const dependency = jobs.find(row => row.key === k);
        if (!dependency || owner(dependency) !== organizationId) return false;
        const [last] = dependency.actionType === "workflow" ? await workflowJobRuns(dependency, 1) : await repos.jobRun.listRecent({ jobId: k, limit: 1 });
        return last?.status === "success";
      }),
    );
    if (greens.every(Boolean)) {
      if (dep.actionType === "workflow") await startWorkflowJob(dep, "dependency", sourceRunId);
      else await startCommandRun(dep, "dependency", sourceRunId);
    }
  }
}
