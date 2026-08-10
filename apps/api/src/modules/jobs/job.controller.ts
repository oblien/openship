/**
 * Job controller — Hono handlers for the self-hosted Jobs tab.
 *
 * Permission + auth are injected by secureRouter via the route tags; these stay
 * thin. Mounted under /api/jobs behind `localOnly` (self-hosted only).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { param, isServerInOrg } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission, checkPermissionOnResource } from "../../lib/permission";
import { streamRunSSE } from "../../lib/run-sse";
import * as jobService from "./job.service";
import { jobRunBus } from "./job-run.sse";
import { resolveServerIds, type CommandConfig } from "./job.types";
import { JOB_TRIGGER_EVENTS } from "./job-events";
import type { TUpdateJobBody, TCreateJobBody } from "./job.schema";

/**
 * Authorize every target server a command job would run on. Jobs are instance-
 * global (no organizationId), and the `job:write` tag only checks org
 * membership — so WITHOUT this a member could create/run a command job pointed
 * at ANY server id (including another org's) and get root RCE on it. Gate each
 * target the same way the terminal / migration paths do: server-admin + the
 * server must resolve inside the caller's org.
 */
async function assertJobServersWritable(c: Context, serverIds: string[]): Promise<Response | null> {
  const ctx = getRequestContext(c);
  for (const serverId of new Set(serverIds)) {
    await permission.assert(ctx, { resourceType: "server", resourceId: serverId, action: "admin" });
    if (!(await isServerInOrg(ctx, serverId))) {
      return c.json({ error: "Server not found" }, 404);
    }
  }
  return null;
}

/**
 * Full authorization to RUN a job by key, shared by the run route and any other
 * caller that can trigger a job (e.g. an incoming-webhook `job` action). Jobs are
 * instance-global, so a bare `runJobNow(key)` bypasses both the `job:write` org
 * gate and the per-target server-admin check. Assert both here so no path can
 * trigger a job the caller couldn't run via `POST /jobs/:key/run`. Returns a
 * Response (403/404) when denied, or null when the caller may run it.
 */
export async function assertJobRunnable(c: Context, key: string): Promise<Response | null> {
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "job", resourceId: "*", action: "write" });
  const row = await repos.job.findByKey(key);
  if (!row) return c.json({ error: "Job not found" }, 404);
  const serverIds = resolveServerIds((row.actionConfig ?? {}) as CommandConfig);
  if (serverIds.length) {
    const denied = await assertJobServersWritable(c, serverIds);
    if (denied) return denied;
  }
  return null;
}

/**
 * Non-throwing boolean form of `assertJobRunnable` — "may this caller run the
 * job with `key`?". Used to gate disclosure of a job-triggering credential (an
 * incoming-webhook token/HMAC IS a run-this-job capability, so it may only be
 * revealed to a principal who could run the job). Returns false on any miss.
 */
export async function canRunJob(c: Context, key: string): Promise<boolean> {
  const ctx = getRequestContext(c);
  if (!(await checkPermissionOnResource(ctx, { resourceType: "job", resourceId: "*", action: "write" }))) {
    return false;
  }
  const row = await repos.job.findByKey(key);
  if (!row) return false;
  const serverIds = resolveServerIds((row.actionConfig ?? {}) as CommandConfig);
  for (const serverId of new Set(serverIds)) {
    if (!(await checkPermissionOnResource(ctx, { resourceType: "server", resourceId: serverId, action: "admin" }))) {
      return false;
    }
    if (!(await isServerInOrg(ctx, serverId))) return false;
  }
  return true;
}

/**
 * Non-throwing read gate for a command job's target servers. Jobs are instance-
 * global and `job:read` only checks org membership, so WITHOUT this any member
 * of any org could read another org's command-job config (env values) and run
 * output (raw stdout/stderr). Mirror the write gate: you may read a command
 * job's config + runs only if you can server-admin every target it runs on and
 * each resolves inside your org. Returns false on the first miss.
 */
async function canAccessServers(c: Context, serverIds: string[]): Promise<boolean> {
  const ctx = getRequestContext(c);
  for (const serverId of new Set(serverIds)) {
    try {
      await permission.assert(ctx, { resourceType: "server", resourceId: serverId, action: "admin" });
    } catch {
      return false;
    }
    if (!(await isServerInOrg(ctx, serverId))) return false;
  }
  return true;
}

/** Read gate for a job row. Builtins are instance operations with no captured
 *  output/env, so any member may read them; command jobs are gated by their
 *  target servers. 404 (not 403) so an unauthorized org can't even confirm the
 *  job exists. */
async function jobReadDenied(c: Context, row: { actionType: string; actionConfig: unknown }): Promise<Response | null> {
  if (row.actionType !== "command") return null;
  const serverIds = resolveServerIds((row.actionConfig ?? {}) as CommandConfig);
  if (serverIds.length === 0) return null;
  if (await canAccessServers(c, serverIds)) return null;
  return c.json({ error: "Job not found" }, 404);
}

/** Read gate for a single run row (by id). System runs carry only a structured
 *  summary → any member. Command runs are gated by the (live job's, else the
 *  run's own) target servers; an orphaned aggregate run whose job was deleted
 *  falls back to owner-only. */
async function runReadDenied(c: Context, run: { kind: string; jobId: string; serverId: string | null }): Promise<Response | null> {
  if (run.kind !== "custom") return null;
  const job = await repos.job.findByKey(run.jobId);
  const serverIds = job
    ? resolveServerIds((job.actionConfig ?? {}) as CommandConfig)
    : run.serverId
      ? [run.serverId]
      : [];
  if (serverIds.length === 0) {
    return getRequestContext(c).role === "owner" ? null : c.json({ error: "Run not found" }, 404);
  }
  if (await canAccessServers(c, serverIds)) return null;
  return c.json({ error: "Run not found" }, 404);
}

export async function list(c: Context) {
  const jobs = await jobService.listJobs();
  // Drop command jobs whose target servers the caller can't access (builtins
  // always shown). Prevents cross-org disclosure of another org's job config.
  const visible = [];
  for (const j of jobs) {
    if (j.actionType !== "command") {
      visible.push(j);
      continue;
    }
    const serverIds = resolveServerIds((j.actionConfig ?? {}) as CommandConfig);
    if (serverIds.length === 0 || (await canAccessServers(c, serverIds))) visible.push(j);
  }
  return c.json({ data: visible });
}

/** GET /jobs/:key — one job with next run + recent run history (detail page). */
export async function get(c: Context) {
  const key = param(c, "key");
  const row = await repos.job.findByKey(key);
  if (!row) return c.json({ error: "Job not found" }, 404);
  const denied = await jobReadDenied(c, row);
  if (denied) return denied;
  return c.json({ data: await jobService.getJob(key) });
}

/** GET /jobs/:key/runs — a job's run history. */
export async function listRuns(c: Context) {
  const key = param(c, "key");
  const row = await repos.job.findByKey(key);
  if (!row) return c.json({ error: "Job not found" }, 404);
  const denied = await jobReadDenied(c, row);
  if (denied) return denied;
  const limit = Number(c.req.query("limit") ?? 50);
  const runs = await repos.jobRun.listRecent({ jobId: key, limit });
  return c.json({ data: runs });
}

/** GET /jobs/trigger-events — curated list of triggerable events (for the UI). */
export async function triggerEvents(c: Context) {
  return c.json({ data: JOB_TRIGGER_EVENTS });
}

/** GET /jobs/backup-schedules — read-only view of the org's scheduled backup
 *  policies, surfaced alongside jobs. Managed under each project's Backups. */
export async function backupSchedules(c: Context) {
  const ctx = getRequestContext(c);
  const data = await jobService.listBackupSchedules(ctx.organizationId);
  return c.json({ data });
}

export async function create(c: Context) {
  const body = await c.req.json<TCreateJobBody>();
  const ctx = getRequestContext(c);
  const denied = await assertJobServersWritable(c, resolveServerIds(body));
  if (denied) return denied;
  const job = await jobService.createCustomJob({ ...body, createdBy: ctx.userId });
  // Return the redacted JobView (never ship secret ciphertext back to the client).
  return c.json({ data: await jobService.getJob(job.key) }, 201);
}

export async function update(c: Context) {
  const key = param(c, "key");
  const body = await c.req.json<TUpdateJobBody>();
  // If the patch re-points the job at (new) servers, authorize those targets.
  const targets = resolveServerIds(body);
  if (targets.length) {
    const denied = await assertJobServersWritable(c, targets);
    if (denied) return denied;
  }
  const updated = await jobService.updateJob(key, body);
  return c.json({ data: await jobService.getJob(updated.key) });
}

export async function remove(c: Context) {
  await jobService.deleteCustomJob(param(c, "key"));
  return c.json({ success: true });
}

export async function run(c: Context) {
  const key = param(c, "key");
  // Re-authorize on every manual run: jobs are instance-global, so run-by-key
  // would otherwise let a member trigger a command job pointed at a server
  // outside their org. Shared with the incoming-webhook `job` action.
  const denied = await assertJobRunnable(c, key);
  if (denied) return denied;
  const result = await jobService.runJobNow(key);
  return c.json({ data: result });
}

/** GET /jobs/runs/:runId — one run row incl. stored output (history detail). */
export async function getRun(c: Context) {
  const run = await repos.jobRun.findById(param(c, "runId"));
  if (!run) return c.json({ error: "Run not found" }, 404);
  const denied = await runReadDenied(c, run);
  if (denied) return denied;
  return c.json({ data: run });
}

/** GET /jobs/runs/:runId/stream — live output + terminal outcome (SSE). */
export async function streamRun(c: Context) {
  const runId = param(c, "runId");
  const run = await repos.jobRun.findById(runId);
  if (!run) return c.json({ error: "Run not found" }, 404);
  const denied = await runReadDenied(c, run);
  if (denied) return denied;
  const finished = run.status === "success" || run.status === "failed";
  return streamRunSSE(c, {
    bus: jobRunBus,
    id: runId,
    snapshot: { type: "snapshot", run },
    terminalComplete: finished
      ? { type: "complete", status: run.status as "success" | "failed", error: run.error }
      : null,
    isFinalEvent: (e) => e.type === "complete",
  });
}
