import { AppError, NotFoundError, safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { ServerDependencies } from "../../../servers";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { withServerExecution } from "../../lib/server-execution";
import { sampleServerUsage, unavailableServerUsage } from "../../lib/server-usage";
import * as managed from "../cloud-workspaces/cloud-workspace.service";
import { availableCloudServers, connectCloudServer } from "../../lib/cloud/server-link";

/** Provider lifecycle stays with its subscription worker. Server operations
 * resolve ownership once and delegate, so project cleanup cannot delete a host. */
async function managedId(ctx: ExecutionContext, id: string) {
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new NotFoundError("Server", id);
  if (!server.workspaceId)
    throw new AppError("This server is managed by its owner", 409, "SERVER_LIFECYCLE_UNAVAILABLE");
  return server.workspaceId;
}

function record(ctx: ExecutionContext, id: string, action: "write" | "admin", operation: string) {
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: `server:${action}`,
    resourceType: "server",
    resourceId: id,
    after: { operation },
  });
}

export const managedServerCollection: Pick<ServerDependencies["collection"], "createManaged" | "availableManaged" | "connectManaged"> = {
  async availableManaged(ctx) {
    return { servers: await availableCloudServers(ctx.organizationId) };
  },
  async connectManaged(ctx, input) {
    const result = await connectCloudServer(ctx.organizationId, input.serverId);
    record(ctx, result.serverId, "admin", "connect");
    return result;
  },
  async createManaged(ctx, input) {
    const result = await managed.create(ctx, input);
    record(ctx, result.serverId, "admin", "create");
    return result;
  },
};

export const serverLifecycleResources: Pick<
  ServerDependencies["resources"],
  "usage" | "ensure" | "previewResize" | "resize" | "retry" | "removeManaged"
> = {
  async usage(ctx, id) {
    const server = await repos.server.getInOrganization(id, ctx.organizationId);
    if (!server) throw new NotFoundError("Server", id);
    if (server.workspaceId) return managed.getUsage(ctx, server.workspaceId);
    let usage;
    try {
      usage = await withServerExecution(ctx.organizationId, id, sampleServerUsage);
    } catch (error) {
      if (error instanceof AppError && [403, 404].includes(error.statusCode)) throw error;
      usage = unavailableServerUsage(safeErrorMessage(error));
    }
    const projects = await repos.project.listActiveByServer(ctx.organizationId, id);
    for (const project of projects) {
      if (
        await authorization.checkPermissionOnResource(ctx, {
          resourceType: "project",
          resourceId: project.id,
          action: "read",
        })
      )
        usage.projects.push({ id: project.id, name: project.name, diskMb: null });
    }
    return usage;
  },
  async ensure(ctx, id) {
    const result = await managed.ensure(ctx, await managedId(ctx, id));
    record(ctx, id, "write", "ensure");
    return result;
  },
  async previewResize(ctx, id) {
    return managed.previewResize(ctx, await managedId(ctx, id));
  },
  async resize(ctx, id, input) {
    const result = await managed.resize(ctx, await managedId(ctx, id), input);
    record(ctx, id, "admin", "resize");
    return result;
  },
  async retry(ctx, id) {
    const result = await managed.retry(ctx, await managedId(ctx, id));
    record(ctx, id, "admin", "retry");
    return result;
  },
  async removeManaged(ctx, id, input) {
    const result = await managed.remove(ctx, await managedId(ctx, id), input);
    record(ctx, id, "admin", "remove");
    return result;
  },
};
