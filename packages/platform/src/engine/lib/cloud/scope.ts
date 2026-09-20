import { AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";

/** A user's cloud login alone is not a mapping between two tenant namespaces. */
export function assertCloudTenantScope(ctx: Pick<ExecutionContext, "scopeMode">): void {
  if (ctx.scopeMode === "fixed") throw new AppError(
    "This cloud link has no tenant mapping. Connect the SDK directly to the cloud instance with its organizationId.",
    409, "CLOUD_SCOPE_UNAVAILABLE",
  );
}
