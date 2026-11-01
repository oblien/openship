import type { ExecutionContext as RequestContext } from "@repo/platform";
import { ensureNamespace } from "@repo/platform/engine/lib/openship-cloud";
import { createTenantCloudAdmin } from "@repo/platform/engine/lib/cloud-tenant-admin";
import { authorizeCloudRelayWorkspace } from "./cloud-relay-access";

export async function createCloudPage(
  ctx: RequestContext,
  input: { workspace_id: string; path: string; name: string; slug: string; domain?: string },
): Promise<unknown> {
  const workspaceId = await authorizeCloudRelayWorkspace(ctx);
  const namespace = await ensureNamespace(ctx.organizationId, workspaceId);
  return createTenantCloudAdmin(ctx.organizationId, namespace, workspaceId).pages!.create(input);
}

export type CloudPageAction = "disable" | "enable" | "delete";

export async function dispatchCloudPageAction(
  ctx: RequestContext, slug: string, action: CloudPageAction,
): Promise<{ ok: true } | { ok: false; status: 403; error: string }> {
  const workspaceId = await authorizeCloudRelayWorkspace(ctx);
  const namespace = await ensureNamespace(ctx.organizationId, workspaceId);
  const pages = createTenantCloudAdmin(ctx.organizationId, namespace, workspaceId).pages!;
  try {
    await pages[action](slug);
    return { ok: true };
  } catch (error) {
    const status = (error as { statusCode?: number; status?: number }).statusCode ??
      (error as { status?: number }).status;
    if (status === 403 || status === 404) {
      return { ok: false, status: 403, error: "Page does not belong to your organization" };
    }
    throw error;
  }
}
