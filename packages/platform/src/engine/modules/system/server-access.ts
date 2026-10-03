import { AppError, NotFoundError } from "@repo/contracts";
import { repos, type Server, type ConnectedServer } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config";
import { isLocalHostRow } from "../../lib/box-org";
import { assertNativeHostExecution, assertNativeSshSettings } from "../../native/execution-policy";

export { assertNativeSshSettings } from "../../native/execution-policy";

export function assertSelfHosted(): void {
  if (env.CLOUD_MODE) throw new AppError("Not available in cloud mode", 404, "CAPABILITY_UNAVAILABLE");
}

export async function requireSelfHostedServer(ctx: ExecutionContext, id: string): Promise<ConnectedServer> {
  assertSelfHosted();
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new NotFoundError("Server", id);
  assertDeploymentServer(server);
  if (server.workspaceId) throw new AppError("Manage this server through its Cloud workspace", 409, "MANAGED_SERVER_LIFECYCLE_REQUIRED");
  if (!server.sshHost) throw new AppError("Server connection is missing", 409, "SERVER_CONNECTION_MISSING");
  return server as ConnectedServer;
}

/** Check before best-effort provider catches, so a policy refusal stays explicit. */
export async function assertServerExecution(server: Server): Promise<void> {
  assertDeploymentServer(server);
  if (server.workspaceId) throw new AppError("Use the Cloud workspace's execution context for this managed server", 409, "MANAGED_SERVER_CONTEXT_REQUIRED");
  if (process.env.OPENSHIP_NATIVE !== "true") return;
  // Match SSH target selection, including founding-org loopback rows that have
  // not yet been adopted as the canonical local server.
  if (await isLocalHostRow(server)) assertNativeHostExecution();
  else assertNativeSshSettings(server);
}

/** A saved import connection grants no deployment, terminal or infrastructure capability. */
export function assertDeploymentServer(server: Pick<Server, "purpose">): void {
  if (server.purpose === "migration_source")
    throw new AppError("This connection is available only for project migration", 403, "MIGRATION_SOURCE_ONLY");
}
