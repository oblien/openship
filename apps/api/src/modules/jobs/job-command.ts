/**
 * Custom (command) job execution.
 *
 * A custom job runs a shell command — which may be `docker run --rm <image>
 * <cmd>` — on one or more servers over the pooled SSH executor, streaming each
 * output line to the job-run SSE bus and storing captured output on the row.
 * Reuses the platform's `sshManager.withExecutor → streamExec` primitive.
 *
 * Advanced policies handled here:
 *   - timeout    Promise.race against the stream (best-effort; can't kill the
 *                remote process, but frees the run + connection).
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

import { repos, type Job, type JobRun } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { LogEntry } from "@repo/adapters";
import { sshManager } from "../../lib/ssh-manager";
import { decryptEnvMap } from "../../lib/encryption";
import { notification } from "../../lib/notification-dispatcher";
import { jobRunBus } from "./job-run.sse";
import { resolveServerIds, type CommandConfig, type JobNotifyConfig, type JobRunState } from "./job.types";

/** Cap stored output so a chatty command can't bloat the row. */
const MAX_OUTPUT = 200_000;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/** Race a promise against a timeout (ms). The remote command keeps running, but
 *  the run is freed and marked failed. No timeout → returns the promise as-is. */
async function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms) return p;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Command timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Run the command on one server, holding the pooled connection for the run. */
async function runOnServer(
  serverId: string,
  command: string,
  onLine: (entry: LogEntry) => void,
): Promise<{ code: number; output: string }> {
  sshManager.retain(serverId);
  try {
    return await sshManager.withExecutor(serverId, (executor) =>
      executor.streamExec(command, onLine),
    );
  } finally {
    sshManager.release(serverId);
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
): Promise<{ status: JobRunState; output: string; error?: string }> {
  const publish = (line: string, level: LogEntry["level"]) =>
    jobRunBus.publish(streamId, { type: "log", line, level });
  try {
    const servers = resolveServerIds(cfg);
    if (!servers.length || !cfg.command?.trim()) {
      throw new Error("Custom job is missing a target server or command.");
    }
    const command = buildCommand(cfg);

    let code: number;
    let output: string;
    if (servers.length === 1) {
      const r = await withTimeout(runOnServer(servers[0], command, (e) => publish(e.message, e.level)), cfg.timeoutMs);
      output = r.output;
      code = r.code;
    } else {
      const results = await Promise.all(
        servers.map(async (sid) => {
          try {
            const r = await withTimeout(
              runOnServer(sid, command, (e) => publish(`[${sid}] ${e.message}`, e.level)),
              cfg.timeoutMs,
            );
            return { sid, code: r.code, output: r.output };
          } catch (err) {
            const msg = safeErrorMessage(err);
            publish(`[${sid}] ${msg}`, "error");
            return { sid, code: 1, output: msg };
          }
        }),
      );
      code = results.every((r) => r.code === 0) ? 0 : 1;
      output = results.map((r) => `── ${r.sid} (exit ${r.code}) ──\n${r.output}`).join("\n\n");
    }

    return code === 0
      ? { status: "success", output }
      : { status: "failed", output, error: `Command exited with code ${code}` };
  } catch (err) {
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

  await emitJobRun(row, run.id, "running");

  let finalStatus: JobRunState = "failed";
  let exitCode = 1;
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
    const res = await executeAttempt(cfg, run.id);
    chunks.push(res.output);
    if (res.status === "success") {
      finalStatus = "success";
      exitCode = 0;
      lastError = undefined;
      break;
    }
    lastError = res.error;
    if (attempt < maxAttempts && backoffMs) await sleep(backoffMs);
  }

  await repos.jobRun.finish(run.id, {
    status: finalStatus,
    durationMs: Date.now() - startedMs,
    summary: { exitCode, attempts: attemptsUsed },
    output: chunks.join("\n").slice(0, MAX_OUTPUT),
    error: finalStatus === "failed" ? lastError ?? "Command failed" : undefined,
  });
  jobRunBus.publish(run.id, { type: "complete", status: finalStatus, error: lastError });

  await emitJobRun(row, run.id, finalStatus);
  if (finalStatus === "success") await fireDependents(row.key);
}

/** Scheduled tick — awaited (inside a runner timer). Reads the latest row so
 *  edits take effect on the next fire. */
export async function runCommandJobTick(key: string): Promise<void> {
  const row = await repos.job.findByKey(key);
  if (!row || row.actionType !== "command") return;
  const cfg = (row.actionConfig ?? {}) as CommandConfig;
  const single = primaryServerId(cfg);
  const run = await repos.jobRun.start({ jobId: key, kind: "custom", trigger: "schedule", serverId: single });
  await runLoop(row, run);
}

/** Fire a job now (or via dependency/event/once). Opens the first run row, kicks
 *  the retry loop in the background, and returns that run id for live logs. */
export async function startCommandRun(
  row: Job,
  trigger: "manual" | "dependency" | "event" | "once" = "manual",
): Promise<string> {
  const cfg = (row.actionConfig ?? {}) as CommandConfig;
  const single = primaryServerId(cfg);
  const run = await repos.jobRun.start({ jobId: row.key, kind: "custom", trigger, serverId: single });
  setImmediate(() => {
    void runLoop(row, run).catch((err) =>
      console.error(`[job] ${row.key} run failed:`, safeErrorMessage(err)),
    );
  });
  return run.id;
}

/** Fire any `once` jobs whose runAt is due, then disable them (system job
 *  jobs:oneshot ticks this every minute — the runner has no delayed schedule). */
export async function runDueOnceJobs(): Promise<{ fired: number }> {
  const now = Date.now();
  const jobs = await repos.job.listAll();
  let fired = 0;
  for (const job of jobs) {
    if (job.scheduleType !== "once" || !job.enabled || job.actionType !== "command") continue;
    if (!job.runAt || job.runAt.getTime() > now) continue;
    await startCommandRun(job, "once");
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

async function resolveOrgIdForUser(userId: string): Promise<string | null> {
  const members = await repos.member.listByUser(userId).catch(() => []);
  return members[0]?.organizationId ?? null;
}

/** Notify on a run state. Per-job `notifyConfig` (if present) OVERRIDES the
 *  global Settings subscriptions — its channels/states win, no double-fire. */
async function emitJobRun(row: Job, runId: string, status: JobRunState): Promise<void> {
  try {
    const payload = { label: row.label, jobKey: row.key, status, runId };
    const notify = row.notifyConfig as JobNotifyConfig | null;

    if (notify?.channels?.length) {
      if (!notify.states?.includes(status)) return;
      for (const channelId of notify.channels) {
        const channel = await repos.notificationChannel.findById(channelId);
        if (!channel || !channel.enabled || !channel.verified) continue;
        const orgId = await resolveOrgIdForUser(channel.userId);
        if (!orgId) continue;
        await repos.notificationDelivery.create({
          userId: channel.userId,
          organizationId: orgId,
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
    const orgId = row.createdBy ? await resolveOrgIdForUser(row.createdBy) : null;
    if (!orgId) return;
    notification.emit({
      organizationId: orgId,
      eventType: STATE_EVENT[status],
      resourceType: "job",
      resourceId: row.key,
      payload,
    });
  } catch (err) {
    console.warn(`[job] notify failed for ${row.key}: ${safeErrorMessage(err)}`);
  }
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/** On a job's success, fire any enabled job that depends on it — but only once
 *  ALL of that dependent's dependencies are currently green. Cycles are
 *  rejected at create/update time, so this terminates. */
async function fireDependents(jobKey: string): Promise<void> {
  try {
    const jobs = await repos.job.listAll();
    for (const dep of jobs) {
      if (!dep.enabled || dep.actionType !== "command") continue;
      const deps = dep.dependsOn ?? [];
      if (!deps.includes(jobKey)) continue;
      const greens = await Promise.all(
        deps.map(async (k) => {
          const [last] = await repos.jobRun.listRecent({ jobId: k, limit: 1 });
          return last?.status === "success";
        }),
      );
      if (greens.every(Boolean)) await startCommandRun(dep, "dependency");
    }
  } catch (err) {
    console.warn(`[job] dependency dispatch failed for ${jobKey}: ${safeErrorMessage(err)}`);
  }
}
