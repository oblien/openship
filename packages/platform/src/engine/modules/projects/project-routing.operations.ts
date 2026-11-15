import { listRouteProtection, changeRouteProtection } from "../../lib/route-protection";
import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { AppError, NotFoundError, isWildcardHostname, normalizeCustomHostname, normalizeResponsePath, safeErrorMessage, type RouteRuleSpec } from "@repo/core";
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
import { HEALTH_WATCH_JOB, healthWatchActive } from "../monitoring/health-watch-policy";
import { isCustomerProject } from "../billing/management.service";
import { resolveProjectDeployTarget } from "./project-deploy-target";

async function localProject(ctx: ExecutionContext, id: string) {
  if (env.CLOUD_MODE && !await isCustomerProject(ctx.organizationId, id)) throw new NotFoundError("Operation");
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);
  return project;
}
async function ownedDomain(projectId: string, domainId?: string | null) {
  if (!domainId) return;
  const domain = await repos.domain.findById(domainId);
  if (!domain || domain.projectId !== projectId)
    throw new AppError("domainId does not belong to this project", 400, "INVALID_DOMAIN");
  return domain;
}
async function responseScope(project: Awaited<ReturnType<typeof localProject>>, input: {
  domainId?: string | null; pathPrefix?: string | null; spec: RouteRuleSpec; enabled?: boolean;
}) {
  const domain = await ownedDomain(project.id, input.domainId);
  if (!input.spec.response) return normalizePathPrefix(input.pathPrefix);
  if (!domain) throw new AppError("Choose a domain for the static response.", 400, "INVALID_DOMAIN");
  const path = normalizeResponsePath(input.pathPrefix ?? "/");
  if (input.enabled !== false) {
    const target = await resolveProjectDeployTarget(project);
    if (project.workspaceId || project.clusterId || target.deployTarget === "cloud" ||
        domain.externalIngress || domain.domainType === "free" || domain.redirectTo ||
        (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none"))
      throw new AppError("Static responses require a domain served by the OpenShip edge. Cloud, external ingress, cluster, and redirect-only domains are not supported.", 400, "EDGE_RESPONSE_UNSUPPORTED");
  }
  return path === "/" ? null : path;
}
async function repush(projectId: string) {
  if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none") return false;
  return pushProjectRulesResolved(projectId).catch(error => {
    errorDiagnostics.warn("platform/engine/modules/projects/project-routing.operations", `[route-rules] push failed: ${safeErrorMessage(error)}`, error);
    return false;
  });
}
function record(ctx: ExecutionContext, projectId: string, operation: string, ruleId: string) {
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "project:write", resourceType: "project", resourceId: projectId,
    after: { operation, ruleId },
  });
}

export const projectRoutingOperations: ResourceServices<typeof ProjectRoutingSchemas> = {
  listRouteProtection,
  async changeRouteProtection(ctx, id, input) {
    const result = await changeRouteProtection(ctx, id, input);
    record(ctx, id, `routeProtection.${input.action}`, input.hostname);
    return result;
  },
  async listRouteRules(ctx, id) {
    await localProject(ctx, id);
    return repos.routeRule.listByProject(id);
  },
  async createRouteRule(ctx, id, input) {
    const project = await localProject(ctx, id);
    const spec = sanitizeSpec(input.spec);
    const pathPrefix = await responseScope(project, { ...input, spec });
    const rule = await repos.routeRule.create({
      organizationId: ctx.organizationId, projectId: id, domainId: input.domainId ?? null,
      pathPrefix, spec, enabled: input.enabled ?? true,
    });
    const edgeApplied = await repush(id);
    record(ctx, id, "routeRule.create", rule.id);
    return { ...rule, edgeApplied: edgeApplied === true };
  },
  async updateRouteRule(ctx, id, input) {
    const project = await localProject(ctx, id);
    const existing = await repos.routeRule.get(input.ruleId);
    if (!existing || existing.projectId !== id || existing.organizationId !== ctx.organizationId)
      throw new NotFoundError("Rule", input.ruleId);
    const spec = input.spec === undefined ? existing.spec : sanitizeSpec(input.spec);
    const pathPrefix = await responseScope(project, {
      domainId: input.domainId === undefined ? existing.domainId : input.domainId,
      pathPrefix: input.pathPrefix === undefined ? existing.pathPrefix : input.pathPrefix,
      enabled: input.enabled ?? existing.enabled, spec,
    });
    const patch: Parameters<typeof repos.routeRule.update>[1] = {};
    if (input.domainId !== undefined) patch.domainId = input.domainId;
    if (input.pathPrefix !== undefined || spec.response) patch.pathPrefix = pathPrefix;
    if (input.spec !== undefined) patch.spec = spec;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    await repos.routeRule.update(input.ruleId, patch);
    const edgeApplied = await repush(id);
    const rule = await repos.routeRule.get(input.ruleId);
    if (!rule || rule.projectId !== id) throw new NotFoundError("Rule", input.ruleId);
    record(ctx, id, "routeRule.update", rule.id);
    return { ...rule, edgeApplied: edgeApplied === true };
  },
  async removeRouteRule(ctx, id, ruleId) {
    await localProject(ctx, id);
    await repos.routeRule.removeForProject(id, ruleId);
    const edgeApplied = await repush(id);
    record(ctx, id, "routeRule.remove", ruleId);
    return { success: true, edgeApplied: edgeApplied === true };
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
    const job = await repos.job.findByKey(HEALTH_WATCH_JOB);
    return {
      open: rows.filter(row => row.status === "open"),
      resolved: rows.filter(row => row.status !== "open" && (row.resolvedAt?.getTime() ?? 0) >= cutoff),
      historyDays, serverUnreachable: incident?.organizationId === ctx.organizationId ? incident : null,
      watching: healthWatchActive(job),
    };
  },
  async connectDomain(ctx, id, input) {
    const hostname = normalizeCustomHostname(input.domain);
    if (!hostname) throw new OperationError("Domain is required", 400, "VALIDATION_ERROR", { success: false });
    try {
      const result = await domainDependencies.collection.create(ctx, id, {
        hostname, isPrimary: !isWildcardHostname(hostname), externalIngress: input.externalIngress ?? false,
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
