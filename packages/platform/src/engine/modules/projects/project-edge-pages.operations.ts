import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AppError,
  normalizeProjectEdgePages,
  resolveProjectEdgePages,
  safeErrorMessage,
  type ProjectEdgePages,
} from "@repo/core";
import { repos, type Project } from "@repo/db";
import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import type { ProjectRoutingSchemas } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { withRouteProtectionLock } from "../../lib/route-protection";
import { findActiveDeployment } from "../../lib/active-deployment";
import { withDeploymentPlatform } from "../../lib/deployment-runtime";
import { assertProjectRoutingCapabilities } from "./project-routing-capabilities";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { domainExecution } from "../domains/domain-execution";

async function owned(ctx: ExecutionContext, id: string) {
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);
  if (project.deletionInProgress)
    throw new AppError("Project cleanup is pending.", 409, "PROJECT_DELETION_PENDING");
  await assertProjectRoutingCapabilities(project, {
    edgePages: project.routingConfig?.edgePages ?? {},
  });
  return project;
}
// Normalize field/hostname order: JSONB does not retain the submitted key order.
const revision = (config: ProjectEdgePages) =>
  createHash("sha256")
    .update(JSON.stringify(normalizeProjectEdgePages(config)))
    .digest("hex");

async function state(ctx: ExecutionContext, project: Project, publish = false) {
  const config = project.routingConfig?.edgePages ?? {};
  const result = { config, revision: revision(config) };
  const domains = await repos.domain.listByProject(project.id);
  const deployment = await findActiveDeployment(project);
  if (!deployment || !domains.length) return { ...result, status: "unpublished" as const };
  try {
    const applied = await withDeploymentPlatform(deployment, async ({ routing }) => {
      if (!routing?.setRouteEdgePages || !routing.getRouteEdgePages)
        throw new AppError(
          "This destination does not support custom edge pages.",
          400,
          "EDGE_PAGES_UNSUPPORTED",
        );
      let all = true;
      for (const domain of domains) {
        await domainExecution(ctx, domain.id);
        const pages = resolveProjectEdgePages(config, domain.hostname);
        if (publish) all = (await routing.setRouteEdgePages(domain.hostname, pages)) && all;
        else
          all = isDeepStrictEqual(await routing.getRouteEdgePages(domain.hostname), pages) && all;
      }
      return all;
    });
    return { ...result, status: applied ? ("applied" as const) : ("pending" as const) };
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/projects/project-edge-pages",
      publish ? "Could not apply edge pages" : "Could not verify edge pages",
      error,
    );
    return { ...result, status: "pending" as const, message: safeErrorMessage(error) };
  }
}

export const projectEdgePageResources: Pick<
  ResourceServices<typeof ProjectRoutingSchemas>,
  "getEdgePages" | "updateEdgePages"
> = {
  async getEdgePages(ctx, id) {
    return state(ctx, await owned(ctx, id));
  },
  async updateEdgePages(ctx, id, input) {
    await owned(ctx, id);
    const normalized = normalizeProjectEdgePages(input.config);
    return withProjectRuntimeLock(id, () =>
      withRouteProtectionLock(id, async () => {
        const project = await owned(ctx, id);
        if (revision(project.routingConfig?.edgePages ?? {}) !== input.expectedRevision)
          throw new AppError(
            "Pages changed in another session. Reload them before saving.",
            409,
            "EDGE_PAGES_CHANGED",
          );
        const domains = await repos.domain.listByProject(id);
        const previous = normalizeProjectEdgePages(project.routingConfig?.edgePages ?? {});
        const hosts: ProjectEdgePages["hosts"] = {};
        for (const [hostname, pages] of Object.entries(normalized.hosts ?? {})) {
          if (domains.some((domain) => domain.hostname === hostname)) hosts[hostname] = pages;
          // A deleted domain may leave an old override in an open editor. Drop
          // that unchanged entry; never accept new settings for an unowned host.
          else if (!isDeepStrictEqual(previous.hosts?.[hostname], pages))
            throw new AppError("Choose a hostname owned by this project.", 400, "INVALID_DOMAIN");
        }
        const config = { ...normalized, ...(normalized.hosts ? { hosts } : {}) };
        for (const domain of domains) await domainExecution(ctx, domain.id);
        const routingConfig = { ...project.routingConfig, edgePages: config };
        await repos.project.update(id, { routingConfig });
        audit.recordAsync(operationAuditContext(ctx), {
          eventType: "project:write",
          resourceType: "project",
          resourceId: id,
        });
        return state(ctx, { ...project, routingConfig }, true);
      }),
    );
  },
};
