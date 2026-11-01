import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { Value } from "@sinclair/typebox/value";
import { repos } from "@repo/db";
import { AppError, safeErrorMessage } from "@repo/core";
import { ServerDetailSchema, type ServerDetail } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { linkedCloudIdentity, remoteCloudRequest } from "./server-link";
import { sameCloudIdentity, resolveOrgCloudUserId } from "./transport";
import { canDiscoverCloudResources } from "./resource-authority";

/** Read the canonical Cloud inventory. Discovery creates no local server,
 * execution capability, subscription or project record. */
export async function readCloudServerInventory(organizationId: string) {
  const identity = await linkedCloudIdentity(organizationId);
  const result = await remoteCloudRequest<{ servers: ServerDetail[] }>(organizationId,
    "/api/system/servers/destinations", undefined, identity);
  if (!Array.isArray(result.servers) || result.servers.some(server =>
    !Value.Check(ServerDetailSchema, server) ||
    (server.managed && server.managed.serverId !== server.id)))
    throw new AppError("Cloud returned an invalid server list", 502, "INVALID_CLOUD_RESPONSE");
  const servers = result.servers.filter(server => server.managed);
  if (new Set(result.servers.map(server => server.id)).size !== result.servers.length ||
    new Set(servers.map(server => server.managed!.id)).size !== servers.length)
    throw new AppError("Cloud returned duplicate server identities", 502, "INVALID_CLOUD_RESPONSE");
  if (!sameCloudIdentity(identity, await linkedCloudIdentity(organizationId)))
    throw new AppError("The Cloud connection changed. Refresh the server list.", 409, "CLOUD_SERVER_CONNECTION_CHANGED");
  return { identity, servers };
}

/** Reconcile by identity, without replicating Cloud state. An explicitly linked
 * execution destination keeps its existing local ID and appears only once. */
export async function mergeCloudServerInventory(ctx: ExecutionContext, local: ServerDetail[]): Promise<ServerDetail[]> {
  if (!canDiscoverCloudResources(ctx) || !await resolveOrgCloudUserId(ctx.organizationId)) return local;
  try {
    const { identity, servers } = await readCloudServerInventory(ctx.organizationId);
    const links = await repos.cloudWorkspace.listByOrganization(ctx.organizationId);
    const visibleIds = new Set(local.map(server => server.id));
    const linkedRemoteIds = new Set<string>();
    const reconciled = local.map(server => {
      const remote = links.find(row => row.id === server.managed?.id && row.remote && sameCloudIdentity(identity, row.remote))?.remote;
      if (!remote) return server;
      linkedRemoteIds.add(remote.serverId);
      return { ...server, cloudReference: { serverId: remote.serverId, workspaceId: remote.workspaceId } };
    });
    return [...reconciled, ...servers.filter(server => !visibleIds.has(server.id) && !linkedRemoteIds.has(server.id))
      .map(server => ({ ...server, source: "cloud" as const }))];
  } catch (error) {
    // Cloud being offline must not hide the user's own servers. Never persist an
    // empty result or interpret a failed read as deletion of a Cloud resource.
    errorDiagnostics.warn("platform/engine/lib/cloud/server-inventory", "[cloud-inventory] Could not list managed servers:", safeErrorMessage(error), error);
    return local;
  }
}
