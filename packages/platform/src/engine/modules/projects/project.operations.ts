import type { ProjectDependencies } from "../../../projects";
import type { CreateProjectInput, EnsureProjectInput } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit } from "../../lib/audit-emitter";
import { assertNativeSourcePath } from "../../native/source-policy";
import { refreshProjectFaviconIfStale } from "../../lib/favicon-detector";
import { createProjectControls } from "./project-controls.operations";
import { createProjectLocalDependencies } from "./project-local.operations";
import { getProjectHome } from "./project-home.operations";
import { subscribeProjectLogs, openProjectServerLogs } from "./project-logs.operations";

async function checkSource(input: Partial<CreateProjectInput>) {
  if (input.localPath && process.env.OPENSHIP_NATIVE === "true") await assertNativeSourcePath(input.localPath);
  if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none" && input.publicEndpoints === undefined) input.publicEndpoints = [];
}

const recordAudit: ProjectDependencies["recordAudit"] = (ctx, event) => {
  audit.recordAsync({ organizationId: ctx.organizationId, actorUserId: ctx.userId, ipAddress: ctx.clientIp, userAgent: ctx.userAgent, source: ctx.source ?? "api", sourceClientId: ctx.sourceClientId }, event);
};

const create = async (ctx: ExecutionContext, input: EnsureProjectInput) => {
    const service = await import("./project.service");
    await checkSource(input);
    if (input.routeStrategy === undefined) {
      const { getRouteStrategy } = await import("../settings/settings.service");
      const preference = await getRouteStrategy(ctx.userId).catch(() => "auto" as const);
      if (preference !== "auto") input.routeStrategy = preference;
    }
    return service.createProject(input, ctx.organizationId, ctx.tokenScope ?? undefined);
};

export const projectDependencies: ProjectDependencies = {
  home: getProjectHome,
  subscribeLogs: subscribeProjectLogs,
  openServerLogs: openProjectServerLogs,
  controls: createProjectControls(recordAudit),
  local: createProjectLocalDependencies(create),
  create,
  async ensure(ctx, input) {
    const service = await import("./project.service");
    await checkSource(input);
    return service.ensureProject(input, ctx.organizationId);
  },
  async get(ctx, id) {
    const service = await import("./project.service");
    const project = await service.getProject(id, ctx.organizationId);
    refreshProjectFaviconIfStale(project);
    return project;
  },
  async update(ctx, id, input) {
    const service = await import("./project.service");
    await checkSource(input);
    return service.updateProject(id, input, ctx.organizationId);
  },
  async list(ctx, input) {
    const service = await import("./project.service");
    // Filter before choosing a group's display environment and paginating.
    // Otherwise an inaccessible production row can hide an accessible preview.
    const restricted = !!ctx.tokenScope || ctx.role === "restricted";
    const result = await service.listProjects(ctx.organizationId, {
      ...input,
      ...(restricted && { canRead: (id: string) => authorization.checkPermissionOnResource(ctx, { resourceType: "project", resourceId: id, action: "read" }) }),
    });
    result.rows.forEach(row => refreshProjectFaviconIfStale(row));
    return { ...result, rows: result.rows.map(p => ({ ...p, source: "local" })) };
  },
  recordAudit,
};
