import { AppError } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import { authorization } from "@repo/platform/engine/lib/authorization";
import {
  cloudBillingOwner,
  requireWorkspaceServer,
  workspaceForServer,
} from "@repo/platform/engine/lib/cloud-workspace-scope";

/** Resolve before provisioning, authorize the concrete host, and carry that
 * selection into the provider call. Legacy single-server relays have exactly
 * the same permission boundary as requests carrying an explicit serverId. */
export async function authorizeCloudRelayWorkspace(
  ctx: ExecutionContext,
  serverId?: string,
  action: "write" | "admin" = "admin",
): Promise<string | null> {
  const selected = serverId ? await workspaceForServer(ctx.organizationId, serverId) : null;
  const workspace = selected
    ? selected.workspace
    : (await cloudBillingOwner(ctx.organizationId)).workspace;
  if ((selected && !workspace) || workspace?.remote || workspace?.deletionInProgress)
    throw new AppError("Managed server not found", 404, "SERVER_NOT_FOUND");
  const server = workspace
    ? (selected?.server ?? (await requireWorkspaceServer(ctx.organizationId, workspace.id)))
    : null;
  // An empty organization may create its initial host only with authority over
  // all servers. A Cloud feature grant cannot bootstrap execution authority.
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: server?.id ?? "*",
    action,
    ...(server ? {} : { scope: "all" as const }),
  });
  return workspace?.id ?? null;
}
