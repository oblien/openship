import type { ExecutionContext } from "../../../context";
import { linkedCloudIdentity } from "./server-link";

/** A user's cloud login alone is not a mapping between two tenant namespaces. */
export async function assertCloudTenantScope(ctx: Pick<ExecutionContext, "organizationId">): Promise<void> {
  await linkedCloudIdentity(ctx.organizationId);
}
