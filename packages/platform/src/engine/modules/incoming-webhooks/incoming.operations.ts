import { AppError, NotFoundError, ValidationError, safeErrorMessage } from "@repo/core";
import { repos, type IncomingWebhookActionConfig } from "@repo/db";
import type { WebhookDependencies } from "../../../webhooks";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { listAuthorizedProjects } from "../../lib/authorized-projects";
import { captureExecutionAuthority } from "../../lib/execution-authority";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { env } from "../../config";
import { assertJobRunnable, canRunJob } from "../jobs/job-access";
import { normalizeDeployActionConfig } from "./incoming-action";
import * as service from "./incoming.service";

function recorded(ctx: ExecutionContext, projectId: string, operation: string, hookId: string) {
  audit.recordAsync(operationAuditContext(ctx), { eventType: "project:write", resourceType: "project", resourceId: projectId, after: { operation: `webhooks.${operation}`, hookId } });
}
function normalize(config: IncomingWebhookActionConfig) {
  try { return normalizeDeployActionConfig(config); }
  catch (error) { throw new ValidationError(safeErrorMessage(error)); }
}
async function authorizeAction(ctx: ExecutionContext, projectId: string, type: "deploy" | "job", config: IncomingWebhookActionConfig, auth: "none" | "token" | "hmac") {
  if (type === "job") {
    if (env.CLOUD_MODE) throw new ValidationError("Job webhooks are not available on Openship Cloud");
    if (auth === "none") throw new ValidationError("Job webhooks require token or HMAC auth");
    if (!config.jobKey) throw new ValidationError("A job is required for a job webhook");
    await assertJobRunnable(ctx, config.jobKey);
  } else {
    try { await service.assertDeployServiceTargets(projectId, config); }
    catch (error) { throw new ValidationError(safeErrorMessage(error)); }
  }
}
async function requireHook(projectId: string, hookId: string) {
  const row = await service.getHookForProject(projectId, hookId);
  if (!row) throw new NotFoundError("Webhook", hookId);
  return row;
}

export const webhooksDependencies: WebhookDependencies = {
  projectFor: async (_ctx, id) => (await repos.incomingWebhook.findById(id))?.projectId,
  projects: {
    async list(ctx, projectId) {
      const canWrite = await authorization.checkPermissionOnResource(ctx, { resourceType: "project", resourceId: projectId, action: "write" });
      return Promise.all((await service.listHookRows(projectId)).map(async row => service.toView(row,
        canWrite && (row.actionType !== "job" || !!row.actionConfig?.jobKey && await canRunJob(ctx, row.actionConfig.jobKey)))));
    },
    async create(ctx, projectId, input) {
      const actionType = input.actionType, authMode = input.authMode ?? "token";
      const config = input.actionConfig ?? {};
      const actionConfig = actionType === "deploy" ? normalize(config) : { jobKey: config.jobKey };
      await authorizeAction(ctx, projectId, actionType, actionConfig, authMode);
      const view = await service.createHook({ projectId, organizationId: ctx.organizationId, name: input.name ?? "Webhook", actionType, actionConfig, authMode, createdBy: ctx.userId, executionAuthority: await captureExecutionAuthority(ctx) });
      recorded(ctx, projectId, "create", view.id);
      return view;
    },
    deliveries: (_ctx, projectId, input) => service.listProjectDeliveries(projectId, input),
  },
  hooks: {
    async update(ctx, projectId, hookId, input) {
      const existing = await requireHook(projectId, hookId);
      const type = input.actionType ?? existing.actionType;
      const auth = input.authMode ?? existing.authMode;
      let next = input.actionConfig;
      const jobKey = next?.jobKey ?? existing.actionConfig?.jobKey;
      const rearming = input.actionType !== undefined || input.actionConfig !== undefined || input.authMode !== undefined || input.enabled === true;
      if (rearming) {
        next = type === "deploy" ? normalize(next ?? existing.actionConfig ?? {}) : { jobKey };
        await authorizeAction(ctx, projectId, type, next, auth);
      }
      const reveal = type !== "job" || !!jobKey && await canRunJob(ctx, jobKey);
      const view = await service.updateHook(projectId, hookId, { ...input, actionConfig: next,
        ...(rearming ? { executionAuthority: await captureExecutionAuthority(ctx) } : {}),
      }, reveal, existing);
      if (!view) throw new NotFoundError("Webhook", hookId);
      recorded(ctx, projectId, "update", hookId);
      return view;
    },
    async rotate(ctx, projectId, hookId) {
      const row = await requireHook(projectId, hookId);
      await authorizeAction(ctx, projectId, row.actionType, row.actionConfig ?? {}, row.authMode);
      const view = await service.rotateCredential(projectId, hookId, await captureExecutionAuthority(ctx), row);
      if (!view) throw new NotFoundError("Webhook", hookId);
      recorded(ctx, projectId, "rotate", hookId);
      return view;
    },
    async remove(ctx, projectId, hookId) {
      if (!(await service.deleteHook(projectId, hookId))) throw new NotFoundError("Webhook", hookId);
      recorded(ctx, projectId, "remove", hookId);
      return { ok: true };
    },
    hookDeliveries: (_ctx, projectId, hookId, input) => service.listHookDeliveries(projectId, hookId, input),
    async invoke(ctx, projectId, hookId) {
      const row = await requireHook(projectId, hookId);
      if (!row.enabled) throw new AppError("This webhook is disabled", 409, "WEBHOOK_DISABLED");
      await authorizeAction(ctx, projectId, row.actionType, row.actionConfig ?? {}, row.authMode);
      const result = await service.dispatchIncomingWebhook(row, { clientIp: ctx.clientIp ?? undefined, userAgent: ctx.userAgent ?? undefined });
      if ("error" in result) throw new AppError("Action failed", 502, "WEBHOOK_ACTION_FAILED");
      recorded(ctx, projectId, "invoke", hookId);
      return { action: result.action, ...(result.ref ? { ref: result.ref } : {}) };
    },
  },
  collection: {
    async listDeliveries(ctx, input = {}) {
      const all = await authorization.checkPermissionOnResource(ctx, { resourceType: "project", resourceId: "*", action: "read", scope: "all" });
      const projectIds = all ? undefined : (await listAuthorizedProjects(ctx, ctx.organizationId)).map(row => row.id);
      return service.listOrgDeliveries(ctx.organizationId, { ...input, projectIds, includeUnassigned: all });
    },
  },
};
