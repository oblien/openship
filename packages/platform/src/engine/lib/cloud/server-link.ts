import { Value } from "@sinclair/typebox/value";
import { AppError, safeErrorMessage } from "@repo/core";
import { repos, type CloudWorkspace, type LinkedCloudServer } from "@repo/db";
import { CloudWorkspaceSchema, ServerDetailSchema, ManagedServerDeletionSchema, type ManagedServerDeletion, type CloudWorkspaceSummary, type ServerDetail } from "@repo/contracts";
import { env } from "../../config/env";
import { requireCloudWorkspace, requireWorkspaceServer } from "../cloud-workspace-scope";
import { cloudFetchAsOrgOwner, readCloudJson, readCloudSession, resolveOrgCloudUserId, sameCloudIdentity, type CloudIdentity } from "./transport";

/** Server links are capabilities verified against Cloud, never caller-supplied
 * provider IDs. All remote lifecycle calls reuse the normal server endpoints. */
export async function linkedCloudIdentity(organizationId: string): Promise<CloudIdentity> {
  const userId = await resolveOrgCloudUserId(organizationId);
  const session = userId ? await readCloudSession(userId) : null;
  if (!session) throw new AppError("Connect Openship Cloud to get a managed server", 409, "CLOUD_NOT_CONNECTED");
  return { apiUrl: session.apiUrl, userId: session.userId, organizationId: session.organizationId };
}

export async function remoteCloudRequest<T>(organizationId: string, path: string, init?: RequestInit, identity?: CloudIdentity): Promise<T> {
  const response = await cloudFetchAsOrgOwner(organizationId, path, init, identity);
  if (!response) throw new AppError("The connected Cloud account is unavailable or has changed. Reconnect the account that owns this server.", 503, "CLOUD_CONNECTION_UNAVAILABLE");
  const body = await readCloudJson<Record<string, unknown>>(response);
  if (!response.ok) throw new AppError(typeof body?.error === "string" ? body.error : "Cloud could not complete the server operation", response.status,
    typeof body?.code === "string" ? body.code : "CLOUD_SERVER_REQUEST_FAILED");
  if (!body) throw new AppError("Cloud returned an invalid server response", 502, "INVALID_CLOUD_RESPONSE");
  return body as T;
}

export async function requireLinkedCloudServer(organizationId: string, workspaceId: string) {
  const row = await requireCloudWorkspace(organizationId, workspaceId);
  if (env.CLOUD_MODE || !row.remote) throw new AppError("This server is not a linked Cloud server", 409, "CLOUD_SERVER_LINK_REQUIRED");
  if (!sameCloudIdentity(await linkedCloudIdentity(organizationId), row.remote))
    throw new AppError("This managed server belongs to a different Cloud connection. Reconnect its account before continuing.", 409, "CLOUD_SERVER_CONNECTION_CHANGED");
  return row as CloudWorkspace & { remote: LinkedCloudServer };
}

export async function linkedServerRequest<T>(organizationId: string, workspaceId: string, suffix: string, init?: RequestInit): Promise<T> {
  const { remote } = await requireLinkedCloudServer(organizationId, workspaceId);
  return remoteCloudRequest<T>(organizationId, `/api/system/servers/${encodeURIComponent(remote.serverId)}${suffix}`, init, remote);
}

export async function localizeCloudSummary(row: CloudWorkspace, result: CloudWorkspaceSummary): Promise<CloudWorkspaceSummary> {
  if (!row.remote || !Value.Check(CloudWorkspaceSchema, result) ||
    result.id !== row.remote.workspaceId || result.serverId !== row.remote.serverId)
    throw new AppError("Cloud returned a different managed server", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
  const server = await requireWorkspaceServer(row.organizationId, row.id);
  const operation = result.operation;
  if (row.operation && operation?.id === row.operation.id && operation.kind === row.operation.kind &&
    ["queued", "running", "failed", "succeeded"].includes(operation.status)) {
    await repos.cloudWorkspace.updateOperation(row.id, {
      ...row.operation,
      status: operation.status as NonNullable<CloudWorkspace["operation"]>["status"],
      logs: operation.logs, error: operation.error, nextAttemptAt: operation.nextAttemptAt,
    }, row.operation.id);
  }
  return { ...result, id: row.id, serverId: server.id };
}

export async function linkedServerSummary(row: CloudWorkspace): Promise<CloudWorkspaceSummary> {
  try {
    const result = await linkedServerRequest<ServerDetail>(row.organizationId, row.id, "");
    if (!Value.Check(ServerDetailSchema, result) || !result.managed)
      throw new AppError("Cloud returned an invalid managed server", 502, "INVALID_CLOUD_RESPONSE");
    return await localizeCloudSummary(row, result.managed);
  } catch (error) {
    // A disconnected account annotates this server, not every other server in
    // the list. Unknown subscription state never grants work or offers checkout.
    const [server, projects] = await Promise.all([
      requireWorkspaceServer(row.organizationId, row.id), repos.project.listByWorkspace(row.id, row.organizationId),
    ]);
    return {
      id: row.id, serverId: server.id, name: row.name, projectCount: projects.length,
      planTierId: "unknown", subscriptionStatus: "unavailable", state: "unreachable", resources: null,
      operation: row.operation ? {
        id: row.operation.id, kind: row.operation.kind, status: row.operation.status,
        requestedAt: row.operation.requestedAt, nextAttemptAt: row.operation.nextAttemptAt,
        error: safeErrorMessage(error), logs: row.operation.logs,
      } : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Check the exact deletion, never infer one from loss of permissions/access. */
export async function confirmLinkedServerDeletion(row: CloudWorkspace): Promise<boolean> {
  if (!row.remote || !row.deletionInProgress || row.operation?.kind !== "delete") return false;
  const { remote } = await requireLinkedCloudServer(row.organizationId, row.id);
  let receipt: ManagedServerDeletion;
  try {
    receipt = await remoteCloudRequest<ManagedServerDeletion>(row.organizationId,
      `/api/cloud/server-deletions/${encodeURIComponent(remote.serverId)}?operationId=${encodeURIComponent(row.operation.id)}`,
      undefined, remote);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) return false;
    throw error;
  }
  if (!Value.Check(ManagedServerDeletionSchema, receipt) || receipt.serverId !== remote.serverId ||
    receipt.workspaceId !== remote.workspaceId || receipt.operationId !== row.operation.id)
    throw new AppError("Cloud returned a different deletion confirmation", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
  await repos.cloudWorkspace.finishDeletion(row.id, row.organizationId);
  return true;
}

export async function availableCloudServers(organizationId: string): Promise<ServerDetail[]> {
  if (env.CLOUD_MODE) return [];
  const identity = await linkedCloudIdentity(organizationId);
  const result = await remoteCloudRequest<{ servers: ServerDetail[] }>(organizationId, "/api/system/servers/destinations", undefined, identity);
  if (!Array.isArray(result.servers) || result.servers.some(server => !Value.Check(ServerDetailSchema, server) ||
    (server.managed && server.managed.serverId !== server.id)))
    throw new AppError("Cloud returned an invalid server list", 502, "INVALID_CLOUD_RESPONSE");
  const linked = await repos.cloudWorkspace.listByOrganization(organizationId);
  return result.servers.filter(server => server.managed && !linked.some(row => row.remote &&
    sameCloudIdentity(row.remote, identity) && row.remote.serverId === server.id));
}

async function saveLink(organizationId: string, identity: CloudIdentity, result: CloudWorkspaceSummary) {
  if (!Value.Check(CloudWorkspaceSchema, result))
    throw new AppError("Cloud returned an invalid managed server", 502, "INVALID_CLOUD_RESPONSE");
  // A reconnect during the remote request must not attach its old response to
  // the new connection. The stored link is also rechecked before every use.
  if (!sameCloudIdentity(identity, await linkedCloudIdentity(organizationId)))
    throw new AppError("The Cloud connection changed. Select the server again.", 409, "CLOUD_SERVER_CONNECTION_CHANGED");
  const row = await repos.cloudWorkspace.link({
    organizationId, name: result.name,
    remote: { ...identity, serverId: result.serverId, workspaceId: result.id },
  });
  return localizeCloudSummary(row, result);
}

export async function connectCloudServer(organizationId: string, serverId: string) {
  const identity = await linkedCloudIdentity(organizationId);
  const result = await remoteCloudRequest<ServerDetail>(organizationId,
    `/api/system/servers/${encodeURIComponent(serverId)}`, undefined, identity);
  if (!Value.Check(ServerDetailSchema, result) || !result.managed || result.id !== serverId || result.managed.serverId !== serverId)
    throw new AppError("Managed server not found", 404, "CLOUD_SERVER_NOT_FOUND");
  // Read access alone does not authorize linking a host-root execution target.
  const verified = await remoteCloudRequest<{ userId: string; organizationId: string; serverId: string; workspaceId: string }>(organizationId,
    `/api/cloud/servers/${encodeURIComponent(serverId)}/authorize`, { method: "POST" }, identity);
  if (verified.userId !== identity.userId || verified.organizationId !== identity.organizationId ||
    verified.serverId !== serverId || verified.workspaceId !== result.managed.id)
    throw new AppError("The managed server is outside this Cloud connection", 404, "SERVER_NOT_FOUND");
  return saveLink(organizationId, identity, result.managed);
}

export async function createLinkedCloudServer(organizationId: string, input: { name: string }) {
  const identity = await linkedCloudIdentity(organizationId);
  const result = await remoteCloudRequest<CloudWorkspaceSummary>(organizationId, "/api/system/servers/managed", {
    method: "POST", body: JSON.stringify(input),
  }, identity);
  return saveLink(organizationId, identity, result);
}
