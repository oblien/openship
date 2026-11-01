import { AppError } from "@repo/core";
import { repos, type AssistantOwner } from "@repo/db";
import type { AssistantTarget } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { assertManagedServerCanWork } from "../../lib/cloud-workspace-access";
import { assertDeploymentServer, assertServerExecution } from "../system/server-access";

export const localAssistantTarget = (): AssistantTarget => ({
  id: "local",
  kind: "local",
  name: env.DEPLOY_MODE === "desktop" ? "This computer" : "This OpenShip host",
});

/** Host installation is an explicit server-admin action, independent of the narrower MCP tool grant. */
export async function resolveAssistantTarget(ctx: ExecutionContext, id?: string | null) {
  if (!id || id === "local") {
    if (env.CLOUD_MODE)
      throw new AppError(
        "Choose one of your servers to run the assistant.",
        403,
        "ASSISTANT_TARGET_REQUIRED",
      );
    return null;
  }
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new AppError("Assistant server not found.", 404, "ASSISTANT_TARGET_NOT_FOUND");
  assertDeploymentServer(server);
  await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action: "admin" });
  if (server.workspaceId) await assertManagedServerCanWork(ctx.organizationId, server.workspaceId);
  else await assertServerExecution(server);
  return server;
}

export async function assistantTargets(ctx: ExecutionContext): Promise<AssistantTarget[]> {
  if (!env.CLOUD_MODE) return [localAssistantTarget()];
  const result: AssistantTarget[] = [];
  for (const server of await repos.server.listByOrganization(ctx.organizationId)) {
    if (server.isLocal || server.purpose === "migration_source") continue;
    try {
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: server.id,
        action: "admin",
      });
      result.push({ id: server.id, name: server.name || "Server", kind: "server" });
    } catch {
      /* A picker must not disclose servers the caller cannot administer. */
    }
  }
  return result;
}

export async function revalidateAssistantTarget(owner: AssistantOwner, serverId: string | null) {
  if (!serverId && !env.CLOUD_MODE) return null;
  // Connections can only be created by authenticated sessions, never delegated agent tokens.
  const context = await resolveExecutionAuthority(
    {
      version: 1,
      userId: owner.userId,
      organizationId: owner.organizationId,
      token: null,
      restrictions: null,
    },
    "assistant-host",
  );
  return resolveAssistantTarget(context, serverId);
}
