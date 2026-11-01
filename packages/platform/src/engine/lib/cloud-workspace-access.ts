import { AppError } from "@repo/core";
import { env } from "../config/env";
import { assertCloudCanSpend } from "../modules/billing/billing-oblien-quota";
import { requireCloudWorkspace } from "./cloud-workspace-scope";
import { remoteServerConnection } from "./cloud/server-connection";

/** Workload admission follows the server's subscription authority in both modes. */
export async function assertManagedServerCanWork(organizationId: string, workspaceId: string) {
  if (!env.CLOUD_MODE) {
    await remoteServerConnection(organizationId, workspaceId, true);
    return;
  }
  const owner = await requireCloudWorkspace(organizationId, workspaceId);
  if (owner.remote || owner.deletionInProgress)
    throw new AppError("The managed server is unavailable", 409, "CLOUD_WORKSPACE_UNAVAILABLE");
  if (owner.operation?.kind === "resize" && owner.operation.status !== "succeeded")
    throw new AppError("Finish the server's resize before starting work", 409, "CLOUD_WORKSPACE_BUSY");
  await assertCloudCanSpend(organizationId, workspaceId);
}
