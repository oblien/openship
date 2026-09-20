import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { AppError, NotFoundError, safeErrorMessage } from "@repo/core";
import { OperationError, type ProjectRoutingSchemas } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ResourceServices } from "../../../resource-operations";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config";
import { assertResourceInOrg } from "../../lib/resource-access";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { pushProjectRulesResolved } from "../route-rules/route-rule.service";
import { sanitizeSpec, normalizePathPrefix } from "../route-rules/rule-inputs";
import { domainDependencies } from "../domains/domain.operations";
import type { AddDomainResult } from "../domains/domain.service";

async function localProject(ctx: ExecutionContext, id: string) {
  if (env.CLOUD_MODE) throw new NotFoundError("Operation");
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);
  return project;
}
async function ownedDomain(projectId: string, domainId?: string | null) {
  if (!domainId) return;
  const domain = await repos.domain.findById(domainId);
  if (!domain || domain.projectId !== projectId)
    throw new AppError("domainId does not belong to this project", 400, "INVALID_DOMAIN");
}
async function repush(projectId: string) {
  if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none") return;
  await pushProjectRulesResolved(projectId).catch(error =>
    console.warn(`[route-rules] push failed: ${safeErrorMessage(error)}`));
}
function record(ctx: ExecutionContext, projectId: string, operation: string, ruleId: string) {
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "project:write", resourceType: "project", resourceId: projectId,
    after: { operation, ruleId },
  });
}

export const projectRoutingOperations: ResourceServices<typeof ProjectRoutingSchemas> = {
  async listRouteRules(ctx, id) {
    await localProject(ctx, id);
    return repos.routeRule.listByProject(id);
  },
  async createRouteRule(ctx, id, input) {
    await localProject(ctx, id);
    await ownedDomain(id, input.domainId);
    const rule = await repos.routeRule.create({
      organizationId: ctx.organizationId, projectId: id, domainId: input.domainId ?? null,
      pathPrefix: normalizePathPrefix(input.pathPrefix), spec: sanitizeSpec(input.spec), enabled: input.enabled ?? true,
    });
    await repush(id);
    record(ctx, id, "routeRule.create", rule.id);
    return rule;
  },
  async updateRouteRule(ctx, id, input) {
    await localProject(ctx, id);
    const existing = await repos.routeRule.get(input.ruleId);
    if (!existing || existing.projectId !== id || existing.organizationId !== ctx.organizationId)
      throw new NotFoundError("Rule", input.ruleId);
    await ownedDomain(id, input.domainId);
    const patch: Parameters<typeof repos.routeRule.update>[1] = {};
    if (input.domainId !== undefined) patch.domainId = input.domainId;
    if (input.pathPrefix !== undefined) patch.pathPrefix = normalizePathPrefix(input.pathPrefix);
    if (input.spec !== undefined) patch.spec = sanitizeSpec(input.spec);
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    await repos.routeRule.update(input.ruleId, patch);
    await repush(id);
    const rule = await repos.routeRule.get(input.ruleId);
    if (!rule || rule.projectId !== id) throw new NotFoundError("Rule", input.ruleId);
    record(ctx, id, "routeRule.update", rule.id);
    return rule;
  },
  async removeRouteRule(ctx, id, ruleId) {
    await localProject(ctx, id);
    await repos.routeRule.removeForProject(id, ruleId);
    await repush(id);
    record(ctx, id, "routeRule.remove", ruleId);
    return { success: true };
  },
  async getIncidents(ctx, id) {
    const project = await localProject(ctx, id);
    const rows = (await repos.serviceIncident.listForProject(id, 100))
      .filter(row => row.organizationId === ctx.organizationId && row.projectId === id);
    const historyDays = 30;
    const cutoff = Date.now() - historyDays * 86_400_000;
    const deployment = project.activeDeploymentId ? await findActiveDeployment(project) : null;
    const serverId = (deployment?.meta as { serverId?: string } | null)?.serverId;
    const incident = serverId ? await repos.serviceIncident.findOpenForServer(serverId) : null;
    const job = await repos.job.findByKey("services:health-watch");
    return {
      open: rows.filter(row => row.status === "open"),
      resolved: rows.filter(row => row.status !== "open" && (row.resolvedAt?.getTime() ?? 0) >= cutoff),
      historyDays, serverUnreachable: incident?.organizationId === ctx.organizationId ? incident : null,
      watching: job ? job.enabled : false,
    };
  },
  async connectDomain(ctx, id, input) {
    const hostname = input.domain.trim();
    if (!hostname) throw new OperationError("Domain is required", 400, "VALIDATION_ERROR", { success: false });
    try {
      const result = await domainDependencies.collection.create(ctx, id, {
        hostname, isPrimary: true, externalIngress: input.externalIngress ?? false,
        sslChallenge: input.sslChallenge, includeWww: input.includeWww ?? false,
      });
      return { success: true, ...(result as AddDomainResult) };
    } catch (error) {
      if (error instanceof AppError && ["CLOUD_SCOPE_UNAVAILABLE", "NOT_FOUND"].includes(error.code ?? "")) throw error;
      if (error instanceof Error) throw new OperationError(error.message, 400, "DOMAIN_CONNECTION_FAILED", { success: false, message: error.message });
      throw error;
    }
  },
};
