import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { readCloudWorkspaceConnection } from "../../lib/cloud-workspace-host";
import { withCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { assertManagedServerCanWork } from "../../lib/cloud-workspace-access";
import { audit, operationAuditContext } from "../../lib/audit-emitter";

export async function managedWorkspaceId(ctx: ExecutionContext, id: string) {
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new NotFoundError("Server", id);
  if (!server.workspaceId || server.purpose === "migration_source")
    throw new AppError(
      "These controls require a managed Cloud server",
      409,
      "MANAGED_SERVER_REQUIRED",
    );
  return server.workspaceId;
}

export async function managedConnection(ctx: ExecutionContext, id: string) {
  const workspaceId = await managedWorkspaceId(ctx, id);
  const connection = await readCloudWorkspaceConnection(ctx.organizationId, workspaceId);
  return {
    ...connection,
    workspaceId,
    workspace: connection.client.workspace(connection.binding.workspaceId!),
  };
}
export type ManagedConnection = Awaited<ReturnType<typeof managedConnection>>;

/** Reauthorize after waiting for the shared activity barrier. A linked
 * installation uses the same durable Cloud admission as deployments/terminals. */
export async function mutateManagedServer<T>(
  ctx: ExecutionContext,
  id: string,
  paid: boolean,
  work: (connection: ManagedConnection) => Promise<T>,
): Promise<T> {
  const workspaceId = await managedWorkspaceId(ctx, id);
  return withCloudWorkspaceActivity(workspaceId, async () => {
    await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action: "admin" });
    if (paid) await assertManagedServerCanWork(ctx.organizationId, workspaceId);
    const connection = await managedConnection(ctx, id);
    if (connection.workspaceId !== workspaceId)
      throw new AppError(
        "The server changed. Refresh before retrying.",
        409,
        "CLOUD_WORKSPACE_CHANGED",
      );
    return work(connection);
  });
}

export function auditManagedControl(
  ctx: ExecutionContext,
  id: string,
  action: string,
  details: Record<string, unknown> = {},
) {
  // Never pass provider responses, command/environment text, keys or tokens here.
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "server:admin",
    resourceType: "server",
    resourceId: id,
    after: { action, ...details },
  });
}

/** Provider transport exceptions may embed internal URLs or credential-bearing
 * request bodies. Give callers a bounded public error, not the raw exception. */
export async function managedProviderCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const status = (error as { status?: unknown })?.status;
    if (status === 404)
      throw new AppError(
        "The managed server resource was not found. Refresh its status.",
        404,
        "MANAGED_RESOURCE_NOT_FOUND",
      );
    if (status === 409)
      throw new AppError(
        "The server is busy or its state changed. Refresh before retrying.",
        409,
        "MANAGED_RESOURCE_CHANGED",
      );
    if (status === 429)
      throw new AppError(
        "The provider is limiting requests. Wait briefly and retry.",
        429,
        "MANAGED_PROVIDER_RATE_LIMITED",
      );
    throw new AppError(
      "The managed server could not complete this operation. Refresh its status before retrying.",
      502,
      "MANAGED_PROVIDER_UNAVAILABLE",
    );
  }
}

export function requireProviderSuccess(result: unknown) {
  if (!result || typeof result !== "object" || !("success" in result) || result.success !== true)
    throw new AppError(
      "The provider did not confirm this change. Refresh the server before retrying.",
      502,
      "MANAGED_CHANGE_UNCONFIRMED",
    );
}
