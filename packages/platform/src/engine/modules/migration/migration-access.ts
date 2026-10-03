import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config";
import { assertDeploymentServer } from "../system/server-access";

/** Ownership and purpose are checked before credentials or provider tokens are read. */
export async function requireMigrationServer(organizationId: string, id: string, role: "source" | "target" = "source") {
  const server = await repos.server.getInOrganization(id, organizationId);
  if (!server) throw new NotFoundError("Server", id);
  if (role === "target") assertDeploymentServer(server);
  if (env.CLOUD_MODE && !server.workspaceId && server.purpose !== "migration_source")
    throw new NotFoundError("Server", id);
  return server;
}

export async function assertMigrationEndpoints(organizationId: string, sourceId: string, targetId: string) {
  // Validate BOTH before opening either connection; never fall back to a default server.
  const source = await requireMigrationServer(organizationId, sourceId);
  const target = await requireMigrationServer(organizationId, targetId, "target");
  if (env.CLOUD_MODE && !target.workspaceId)
    throw new AppError("Choose a managed server for this import", 400, "MANAGED_MIGRATION_TARGET_REQUIRED");
  return { source, target };
}
