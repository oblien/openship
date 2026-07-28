/**
 * HTTP handlers for generic per-project incoming webhooks.
 *
 *  - `triggerHook`  PUBLIC — `POST /api/webhooks/incoming/:id`. No session auth;
 *    the hook's own token / HMAC is the credential (or `none`). Mounted on the
 *    unified webhook router.
 *  - CRUD           project-scoped management (`project:read` / `project:write`).
 */

import type { Context } from "hono";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission, checkPermissionOnResource } from "../../lib/permission";
import { safeErrorMessage } from "@repo/core";
import {
  createHook,
  listHookRows,
  updateHook,
  deleteHook,
  rotateCredential,
  triggerIncomingWebhook,
  getHookForProject,
  toView,
  isValidActionType,
  isValidAuthMode,
  listProjectDeliveries,
  listHookDeliveries,
  listOrgDeliveries,
} from "./incoming.service";
import { assertJobRunnable, canRunJob } from "../jobs/job.controller";
import { env } from "../../config";
import type { IncomingWebhookActionConfig } from "@repo/db";

// ─── Public trigger ──────────────────────────────────────────────────────────

/**
 * Extract the presented bearer token from the Authorization header ONLY.
 * Deliberately NOT from `?token=` — a query-string token leaks into edge/proxy
 * access logs, browser history, and Referer headers (matches the backup trigger,
 * which is header-only for the same reason).
 */
function extractBearer(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m?.[1]) return m[1].trim();
  return null;
}

export async function triggerHook(c: Context) {
  const id = param(c, "id");
  const bearer = extractBearer(c);
  const signature =
    c.req.header("x-hub-signature-256") ??
    c.req.header("x-signature-256") ??
    c.req.header("x-signature") ??
    null;

  const result = await triggerIncomingWebhook({
    id,
    bearer,
    signature,
    rawBody: c.var.webhookRawBody,
    clientIp: c.var.clientIp ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });

  if ("error" in result) {
    // Auth / existence failures are opaque (404) so a caller can't probe for
    // valid hook ids or token prefixes. A genuine action failure is a 502.
    if (result.error === "action_failed") {
      return c.json({ error: "Action failed" }, 502);
    }
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ data: { action: result.action, ref: result.ref } });
}

// ─── Management (project-scoped) ─────────────────────────────────────────────

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "read" });
  // Reveal the plaintext trigger secret only to a principal who could USE it:
  // project:write for a deploy hook, and additionally job-run authz for a job
  // hook (its credential is a run-this-job capability). Everyone else gets it
  // masked, so read-only / project-write-only principals can't harvest a
  // credential to fire actions they aren't authorized to perform.
  const canWrite = await checkPermissionOnResource(ctx, {
    resourceType: "project",
    resourceId: projectId,
    action: "write",
  });
  const rows = await listHookRows(projectId);
  const data = await Promise.all(
    rows.map(async (row) => {
      let reveal = canWrite;
      if (reveal && row.actionType === "job") {
        reveal = row.actionConfig?.jobKey ? await canRunJob(c, row.actionConfig.jobKey) : false;
      }
      return toView(row, reveal);
    }),
  );
  return c.json({ data });
}

function pageOpts(c: Context): { cursor?: string; limit?: number } {
  const raw = c.req.query("limit");
  const limit = raw ? Number(raw) : undefined;
  return {
    cursor: c.req.query("cursor") || undefined,
    limit: limit && Number.isFinite(limit) ? limit : undefined,
  };
}

/** GET /:id/webhook-deliveries — the project's webhook delivery feed (github + custom). */
export async function deliveries(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "read" });
  return c.json({ data: await listProjectDeliveries(projectId, pageOpts(c)) });
}

/** GET /:id/incoming-webhooks/:hookId/deliveries — one hook's deliveries. */
export async function hookDeliveries(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "read" });
  return c.json({ data: await listHookDeliveries(projectId, param(c, "hookId"), pageOpts(c)) });
}

/** GET (org-level) — all deliveries in the org, incl forwarded/unmatched GitHub pushes. */
export async function orgDeliveries(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await listOrgDeliveries(ctx.organizationId, pageOpts(c)) });
}

export async function create(c: Context) {
  const projectId = param(c, "id");
  await permission.assert(getRequestContext(c), {
    resourceType: "project",
    resourceId: projectId,
    action: "write",
  });
  // Read ctx AFTER assert: permission.assert rebinds it to the PROJECT's org, so
  // the hook is attributed to the project's tenant, not the caller's stale
  // active org (a multi-org member's active org can differ from the project's).
  const ctx = getRequestContext(c);

  const body = await c.req.json().catch(() => ({}));
  const actionType = body?.actionType;
  const authMode = body?.authMode ?? "token";
  if (!isValidActionType(actionType)) {
    return c.json({ error: "Invalid action type" }, 400);
  }
  if (!isValidAuthMode(authMode)) {
    return c.json({ error: "Invalid auth mode" }, 400);
  }
  const actionConfig: IncomingWebhookActionConfig = {
    serviceId: typeof body?.actionConfig?.serviceId === "string" ? body.actionConfig.serviceId : undefined,
    jobKey: typeof body?.actionConfig?.jobKey === "string" ? body.actionConfig.jobKey : undefined,
  };
  if (actionType === "job") {
    // Jobs are a self-hosted control-plane feature (Jobs API is localOnly). No
    // job hooks on the SaaS — else a tenant could arm instance-global jobs.
    if (env.CLOUD_MODE) {
      return c.json({ error: "Job webhooks are not available on Openship Cloud" }, 400);
    }
    if (!actionConfig.jobKey) {
      return c.json({ error: "A job is required for a job webhook" }, 400);
    }
    // A job hook is a run-this-job capability. Authorize it exactly like
    // POST /jobs/:key/run (job:write + server-admin on every target) so a
    // project:write-only principal can't escalate to running arbitrary jobs.
    const denied = await assertJobRunnable(c, actionConfig.jobKey);
    if (denied) return denied;
    // No unauthenticated job triggers — a `none` job hook would be open RCE.
    if (authMode === "none") {
      return c.json({ error: "Job webhooks require token or HMAC auth" }, 400);
    }
  }

  try {
    const view = await createHook({
      projectId,
      organizationId: ctx.organizationId,
      name: typeof body?.name === "string" ? body.name : "Webhook",
      actionType,
      actionConfig,
      authMode,
      createdBy: ctx.user?.id ?? null,
    });
    return c.json({ data: view }, 201);
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function update(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const hookId = param(c, "hookId");
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "write" });

  const body = await c.req.json().catch(() => ({}));
  if (body?.actionType !== undefined && !isValidActionType(body.actionType)) {
    return c.json({ error: "Invalid action type" }, 400);
  }
  if (body?.authMode !== undefined && !isValidAuthMode(body.authMode)) {
    return c.json({ error: "Invalid auth mode" }, 400);
  }

  // If this edit results in (or re-arms) a JOB hook, re-run the full job-run
  // authorization on the effective jobKey — otherwise update would be a way to
  // sidestep the create-time gate (swap the target job, flip a deploy hook to a
  // job, or enable a job hook the caller couldn't have created).
  const existing = await getHookForProject(projectId, hookId);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const finalType = body?.actionType ?? existing.actionType;
  const finalJobKey =
    (typeof body?.actionConfig?.jobKey === "string" ? body.actionConfig.jobKey : undefined) ??
    existing.actionConfig?.jobKey;
  const touchesActionOrAuth =
    body?.actionType !== undefined || body?.actionConfig !== undefined || body?.authMode !== undefined;
  const enabling = body?.enabled === true;
  if (finalType === "job" && (touchesActionOrAuth || enabling)) {
    if (env.CLOUD_MODE) {
      return c.json({ error: "Job webhooks are not available on Openship Cloud" }, 400);
    }
    const finalAuth = body?.authMode ?? existing.authMode;
    if (finalAuth === "none") {
      return c.json({ error: "Job webhooks require token or HMAC auth" }, 400);
    }
    if (!finalJobKey) return c.json({ error: "A job is required for a job webhook" }, 400);
    const denied = await assertJobRunnable(c, finalJobKey);
    if (denied) return denied;
  }

  // Reveal the (possibly re-minted) secret in the response only to a caller who
  // may USE it — a benign PATCH on a job hook must not leak its credential to a
  // project:write-only principal who can't run the job.
  const reveal =
    finalType === "job" ? (finalJobKey ? await canRunJob(c, finalJobKey) : false) : true;

  const view = await updateHook(
    projectId,
    hookId,
    {
      name: typeof body?.name === "string" ? body.name : undefined,
      enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
      actionType: body?.actionType,
      actionConfig: body?.actionConfig,
      authMode: body?.authMode,
    },
    reveal,
  );
  if (!view) return c.json({ error: "Not found" }, 404);
  return c.json({ data: view });
}

export async function rotate(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const hookId = param(c, "hookId");
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "write" });
  // Rotating a job hook hands the caller a fresh working credential for it, so
  // it needs the same job-run authz as creating/firing one — otherwise rotate
  // would be a back door around the create/update gate.
  const existing = await getHookForProject(projectId, hookId);
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.actionType === "job" && existing.actionConfig?.jobKey) {
    const denied = await assertJobRunnable(c, existing.actionConfig.jobKey);
    if (denied) return denied;
  }
  const view = await rotateCredential(projectId, hookId);
  if (!view) return c.json({ error: "Not found" }, 404);
  return c.json({ data: view });
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const hookId = param(c, "hookId");
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "write" });
  const ok = await deleteHook(projectId, hookId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { ok: true } });
}
