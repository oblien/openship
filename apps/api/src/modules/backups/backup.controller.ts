/**
 * HTTP handlers for backups: policy CRUD, list runs, manual trigger.
 * Webhook + cron triggers land in Chunk 2; their handlers will live
 * in this file alongside the manual one.
 */

import type { Context } from "hono";
import crypto from "node:crypto";
import { repos } from "@repo/db";
import { assertResourceInOrg, isServerInOrg, param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { streamRunSSE } from "../../lib/run-sse";
import { triggerManualBackup } from "./triggers/manual";
import { backupRunBus } from "./backup.sse";
import { restoreRunBus } from "./restore.sse";
import { restoreOrchestrator } from "./restore.orchestrator";
import { safeErrorMessage } from "@repo/core";
import {
  createPolicy,
  deletePolicy,
  getRun,
  listPoliciesByProject,
  listRunsForProject,
  updatePolicy,
  type UpdatePolicyPatch,
} from "./backup.service";

// ─── Policies ────────────────────────────────────────────────────────────────

export async function listProjectPolicies(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "projectId");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "read" });
  try {
    const policies = await listPoliciesByProject(ctx, projectId);
    return c.json({ data: policies });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function createProjectPolicy(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "projectId");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "write" });
  const body = await c.req.json<{
    serviceId?: string | null;
    destinationId: string;
    cronExpression?: string;
    triggerOnPreDeploy?: boolean;
    retainCount?: number;
    retainDays?: number;
    payloadKind?: string;
    payloadConfig?: Record<string, unknown>;
    preHook?: string;
    postHook?: string;
    enabled?: boolean;
  }>();
  if (!body.destinationId) {
    return c.json({ error: "destinationId is required" }, 400);
  }
  try {
    const policy = await createPolicy(ctx, {
      projectId,
      serviceId: body.serviceId ?? null,
      destinationId: body.destinationId,
      cronExpression: body.cronExpression,
      triggerOnPreDeploy: body.triggerOnPreDeploy,
      retainCount: body.retainCount,
      retainDays: body.retainDays,
      payloadKind: body.payloadKind,
      payloadConfig: body.payloadConfig,
      preHook: body.preHook,
      postHook: body.postHook,
      enabled: body.enabled,
    });
    return c.json({ data: policy });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function patchPolicy(c: Context) {
  const ctx = getRequestContext(c);
  const policyId = param(c, "policyId");
  // Derive parent projectId for the permission gate. Restricted users
  // need a grant on the project; the policy doesn't have a grant root
  // of its own.
  const existing = await repos.backupPolicy.findById(policyId);
  if (existing?.projectId) {
    await permission.assert(getRequestContext(c), {
      resourceType: "project",
      resourceId: existing.projectId,
      action: "write",
    });
  }
  const raw = (await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}))) as Record<string, unknown>;

  // Pluck only the fields UpdatePolicyPatch knows about. updatePolicy
  // also allow-lists internally, but doing it here gives a clean 400
  // for malformed input and prevents unknown fields from making it
  // into application state at all.
  const patch: UpdatePolicyPatch = {};
  const allowed: Array<keyof UpdatePolicyPatch> = [
    "cronExpression",
    "triggerOnPreDeploy",
    "enableWebhook",
    "rotateWebhookToken",
    "retainCount",
    "retainDays",
    "payloadKind",
    "payloadConfig",
    "preHook",
    "postHook",
    "hookTimeoutSeconds",
    "enabled",
    "destinationId",
  ];
  for (const key of allowed) {
    if (key in raw) {
      (patch as Record<string, unknown>)[key as string] = raw[key as string];
    }
  }

  try {
    const policy = await updatePolicy(ctx, policyId, patch);
    return c.json({ data: policy });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function removePolicy(c: Context) {
  const ctx = getRequestContext(c);
  const policyId = param(c, "policyId");
  // Derive parent projectId — delete is an admin-level mutation on the
  // parent project's resource tree.
  const existing = await repos.backupPolicy.findById(policyId);
  if (existing?.projectId) {
    await permission.assert(getRequestContext(c), {
      resourceType: "project",
      resourceId: existing.projectId,
      action: "admin",
    });
  }
  try {
    await deletePolicy(ctx, policyId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export async function listRuns(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "projectId");
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "read" });
  const serviceId = c.req.query("serviceId");
  const limit = Number(c.req.query("limit") ?? "50");
  try {
    const runs = await listRunsForProject(ctx, projectId, {
      limit: Number.isFinite(limit) ? limit : 50,
      serviceId,
    });
    return c.json({ data: runs });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function getOneRun(c: Context) {
  const ctx = getRequestContext(c);
  const runId = param(c, "runId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_run", resourceId: runId, action: "read" });
  try {
    const run = await getRun(ctx, runId);
    return c.json({ data: run });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

/**
 * GET /api/backup-runs/:runId/stream
 *
 * SSE channel for run progress. Sends a `snapshot` event with the
 * current DB row immediately, then live `transition` / `progress` /
 * `complete` events as they fire from the orchestrator. Identical
 * shape to the deployment SSE channel — survives reload because the
 * DB row is authoritative.
 */
export async function streamRun(c: Context) {
  const ctx = getRequestContext(c);
  const runId = param(c, "runId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_run", resourceId: runId, action: "read" });

  // Ownership check before opening the stream.
  let initial;
  try {
    initial = await getRun(ctx, runId);
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }

  const TERMINAL = ["succeeded", "failed", "cancelled", "server_error"];
  const finished = TERMINAL.includes(initial.status);
  return streamRunSSE(c, {
    bus: backupRunBus,
    id: runId,
    snapshot: { type: "snapshot", run: initial },
    terminalComplete: finished
      ? {
          type: "complete",
          status: initial.status as "succeeded" | "failed" | "cancelled" | "server_error",
        }
      : null,
    isFinalEvent: (ev) => ev.type === "complete",
  });
}

// ─── Manual trigger ──────────────────────────────────────────────────────────

export async function triggerManual(c: Context) {
  const ctx = getRequestContext(c);
  const policyId = param(c, "policyId");
  // Derive parent projectId — running a backup is a write on the project.
  const policy = await repos.backupPolicy.findById(policyId);
  if (policy?.projectId) {
    await permission.assert(getRequestContext(c), {
      resourceType: "project",
      resourceId: policy.projectId,
      action: "write",
    });
  }
  try {
    const { runId } = await triggerManualBackup(ctx, policyId);
    return c.json({ data: { runId } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

// ─── Restore ─────────────────────────────────────────────────────────────────

/**
 * POST /api/backup-runs/:runId/restore/prepare
 * Returns { restoreId, confirmationToken }. The token must be echoed
 * back on the apply call — protects against accidental re-submits.
 */
export async function prepareRestore(c: Context) {
  const ctx = getRequestContext(c);
  const runId = param(c, "runId");
  // Restore prep is a destructive admin op against the run's destination.
  await permission.assert(getRequestContext(c), { resourceType: "backup_run", resourceId: runId, action: "admin" });
  const clientIp = c.var.clientIp ?? undefined;

  // Ownership check (org-scoped).
  const run = await repos.backupRun.findById(runId);
  try {
    assertResourceInOrg(run, "Backup run", ctx.organizationId, runId);
  } catch {
    return c.json({ error: "Backup run not found" }, 404);
  }

  // Optional migration target: restore a mail-server backup onto a
  // DIFFERENT mail server (mode="to_fork"). Validate the target is a
  // registered, installed mail server in the caller's org before staging.
  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: "in_place" | "to_fork";
    forkMailServerId?: string | null;
  };
  const mode = body.mode === "to_fork" ? "to_fork" : "in_place";
  let forkMailServerId: string | null = null;
  if (mode === "to_fork") {
    if (run.sourceKind !== "mail_server") {
      return c.json({ error: "Only mail-server backups can be migrated to another server" }, 400);
    }
    forkMailServerId = body.forkMailServerId ?? null;
    if (!forkMailServerId) {
      return c.json({ error: "A target mail server is required to migrate" }, 400);
    }
    if (forkMailServerId === run.mailServerId) {
      return c.json({ error: "Pick a different server than the source" }, 400);
    }
    const target = await repos.mailServer.get(forkMailServerId);
    if (!target || !target.installedAt) {
      return c.json(
        { error: "Target must be a mail server that's already set up (install it first)" },
        400,
      );
    }
    if (!(await isServerInOrg(ctx, forkMailServerId))) {
      return c.json({ error: "Target server not found" }, 404);
    }
  }

  const confirmationToken = crypto.randomBytes(8).toString("hex");
  try {
    const { restoreId } = await restoreOrchestrator.beginPrepare({
      runId,
      trigger: { source: "manual", userId: ctx.userId, clientIp },
      confirmationToken,
      mode,
      forkMailServerId,
    });
    return c.json({ data: { restoreId, confirmationToken } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/**
 * POST /api/backup-restores/:restoreId/apply
 * Body: { confirmationToken }
 */
export async function applyRestore(c: Context) {
  const ctx = getRequestContext(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_restore", resourceId: restoreId, action: "admin" });
  const body = await c.req
    .json<{ confirmationToken?: string }>()
    .catch(() => ({} as { confirmationToken?: string }));
  if (!body.confirmationToken) {
    return c.json({ error: "confirmationToken is required" }, 400);
  }
  try {
    await restoreOrchestrator.apply(ctx, restoreId, body.confirmationToken);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/** POST /api/backup-restores/:restoreId/cancel */
export async function cancelRestore(c: Context) {
  const ctx = getRequestContext(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_restore", resourceId: restoreId, action: "admin" });
  try {
    await restoreOrchestrator.cancel(ctx, restoreId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/** GET /api/backup-restores/:restoreId */
export async function getOneRestore(c: Context) {
  const ctx = getRequestContext(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_restore", resourceId: restoreId, action: "read" });
  const row = await repos.backupRestore.findById(restoreId);
  try {
    assertResourceInOrg(row, "Restore", ctx.organizationId, restoreId);
  } catch {
    return c.json({ error: "Restore not found" }, 404);
  }
  return c.json({ data: row });
}

/**
 * GET /api/backup-restores/:restoreId/stream
 * SSE channel for restore progress. Same shape as backup-runs/:id/stream.
 */
export async function streamRestore(c: Context) {
  const ctx = getRequestContext(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_restore", resourceId: restoreId, action: "read" });
  const initial = await repos.backupRestore.findById(restoreId);
  try {
    assertResourceInOrg(initial, "Restore", ctx.organizationId, restoreId);
  } catch {
    return c.json({ error: "Restore not found" }, 404);
  }

  const TERMINAL = ["succeeded", "failed", "cancelled", "server_error"];
  const finished = TERMINAL.includes(initial.status);
  return streamRunSSE(c, {
    bus: restoreRunBus,
    id: restoreId,
    snapshot: { type: "snapshot", restore: initial },
    terminalComplete: finished
      ? {
          type: "complete",
          status: initial.status as "succeeded" | "failed" | "cancelled" | "server_error",
        }
      : null,
    isFinalEvent: (ev) => ev.type === "complete",
  });
}

// ─── Protect-from-retention ──────────────────────────────────────────────────

/**
 * POST /api/backup-runs/:runId/protect
 * Body: { until?: ISO string, protected?: boolean }
 * - protected:true with no `until` = locked forever (well, until 2099).
 * - protected:false clears the lock so retention prune can drop it.
 */
export async function protectRun(c: Context) {
  const ctx = getRequestContext(c);
  const runId = param(c, "runId");
  await permission.assert(getRequestContext(c), { resourceType: "backup_run", resourceId: runId, action: "write" });
  const body = await c.req
    .json<{ until?: string; protected?: boolean }>()
    .catch(() => ({} as { until?: string; protected?: boolean }));

  const run = await repos.backupRun.findById(runId);
  try {
    assertResourceInOrg(run, "Backup run", ctx.organizationId, runId);
  } catch {
    return c.json({ error: "Backup run not found" }, 404);
  }

  let lockedUntil: Date | null = null;
  if (body.protected === false) {
    lockedUntil = null;
  } else if (body.until) {
    const parsed = new Date(body.until);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: "Invalid 'until' timestamp" }, 400);
    }
    lockedUntil = parsed;
  } else if (body.protected === true || body.protected === undefined) {
    lockedUntil = new Date("2099-12-31T23:59:59.000Z");
  }

  await repos.backupRun.setRetentionLock(runId, lockedUntil);
  return c.json({ data: { ok: true, retentionLockedUntil: lockedUntil?.toISOString() ?? null } });
}
