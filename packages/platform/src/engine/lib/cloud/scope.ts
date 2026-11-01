import { AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { linkedCloudIdentity } from "./server-link";

/** A user's cloud login alone is not a mapping between two tenant namespaces. */
export async function assertCloudTenantScope(ctx: Pick<ExecutionContext, "organizationId">): Promise<void> {
  await linkedCloudIdentity(ctx.organizationId);
}

/** A local grant cannot authorize access through the owner's Cloud credential.
 * Managed server execution uses its separately verified server binding instead.
 * The credential restriction also applies when a caller omits organizationId. */
export function canProxyCloudResources(ctx: ExecutionContext): boolean {
  return ctx.scopeMode !== "fixed" && !ctx.tokenScope && ctx.role !== "restricted" && !ctx.credential?.organizationId;
}

export function assertCloudProxyScope(ctx: ExecutionContext): void {
  if (!canProxyCloudResources(ctx)) {
    throw new AppError(
      "This credential is scoped to this Openship instance. To deploy from desktop, select a connected managed server with serverId and keep the project here. To manage projects stored in Cloud, authorize a separate connection to the Cloud API's /api/mcp and use its organizationId. Omitting organizationId does not widen this credential's access.",
      409,
      "CLOUD_SCOPE_UNAVAILABLE",
    );
  }
}
