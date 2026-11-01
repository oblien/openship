import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { requireLinkedCloudServer } from "./server-link";

/** Cloud-owned requests use canonical IDs. A picker may hold an explicit local
 * execution link instead; translate that verified link, never a client's alias. */
export async function cloudServerReference(organizationId: string, id: string): Promise<string> {
  const server = await repos.server.get(id);
  if (!server) return id;
  if (server.organizationId !== organizationId) throw new NotFoundError("Server", id);
  if (!server.workspaceId)
    throw new AppError("Choose a managed Cloud server for this Cloud project", 409, "CLOUD_SERVER_REQUIRED");
  return (await requireLinkedCloudServer(organizationId, server.workspaceId)).remote.serverId;
}

export async function cloudWorkspaceReference(organizationId: string, id: string): Promise<string> {
  const row = await repos.cloudWorkspace.findById(id);
  if (!row) return id;
  return (await requireLinkedCloudServer(organizationId, id)).remote.workspaceId;
}

/** Only routing fields are translated; env values and other user content remain
 * opaque, even if they happen to contain a server ID. */
export async function cloudRequestReferences(organizationId: string, value: Record<string, unknown>) {
  const result = { ...value };
  for (const field of ["serverId", "buildServerId"] as const) {
    if (typeof result[field] === "string" && result[field])
      result[field] = await cloudServerReference(organizationId, result[field]);
  }
  if (typeof result.workspaceId === "string" && result.workspaceId)
    result.workspaceId = await cloudWorkspaceReference(organizationId, result.workspaceId);
  return result;
}
