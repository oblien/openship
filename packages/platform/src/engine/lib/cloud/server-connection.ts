import { Value } from "@sinclair/typebox/value";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { ManagedServerConnectionSchema, type ManagedServerConnection, type ServerDetail } from "@repo/contracts";
import { createProvisionLock } from "../provision-lock";
import { linkedServerRequest, remoteCloudRequest, requireLinkedCloudServer } from "./server-link";

/** Resolve live authority, then retain only the host identity needed by local
 * project snapshots. Billing and provisioning records are never copied. */
export async function remoteServerConnection(
  organizationId: string,
  workspaceId: string,
  work = false,
): Promise<ManagedServerConnection> {
  const { remote } = await requireLinkedCloudServer(organizationId, workspaceId);
  const connection = await remoteCloudRequest<ManagedServerConnection>(organizationId,
    `/api/cloud/servers/${encodeURIComponent(remote.serverId)}/connection`,
    { method: "POST", body: JSON.stringify({ work }) }, remote);
  if (!Value.Check(ManagedServerConnectionSchema, connection) ||
    connection.userId !== remote.userId || connection.organizationId !== remote.organizationId ||
    connection.serverId !== remote.serverId || connection.ownerWorkspaceId !== remote.workspaceId ||
    !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now())
    throw new AppError("Cloud returned a different server connection", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
  await createProvisionLock(`cloud:linked-server:${workspaceId}`).run(async () => {
    await requireLinkedCloudServer(organizationId, workspaceId);
    await repos.cloudWorkspace.setNamespace(workspaceId, organizationId, connection.namespace);
    const owner = { ownerWorkspaceId: workspaceId };
    const binding = await repos.cloudDockerWorkspace.reserve({
      ...owner, namespace: connection.namespace, image: connection.image, resources: connection.resources,
    }, organizationId);
    if (binding.workspaceId && binding.workspaceId !== connection.workspaceId)
      throw new AppError("The managed server was replaced. Review its data before reconnecting.", 409, "CLOUD_SERVER_IDENTITY_MISMATCH");
    await repos.cloudDockerWorkspace.attach(owner, organizationId, connection.namespace, connection.workspaceId);
    await repos.cloudDockerWorkspace.updateResources(owner, organizationId, connection.workspaceId, connection.resources);
    await repos.cloudDockerWorkspace.markReady(owner, organizationId, connection.workspaceId);
  });
  return connection;
}

/** The SaaS durable worker provisions the server. Local deployments only wait
 * for that operation; they cannot allocate a second VM or bypass its plan. */
export async function ensureLinkedCloudServer(input: {
  organizationId: string;
  ownerWorkspaceId: string;
  existingWorkspaceId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { organizationId, ownerWorkspaceId } = input;
  input.signal?.throwIfAborted();
  if (input.existingWorkspaceId) {
    const binding = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId }, organizationId);
    if (binding?.workspaceId !== input.existingWorkspaceId)
      throw new AppError("The server does not own this deployment", 404, "CLOUD_WORKSPACE_NOT_FOUND");
  }
  await linkedServerRequest(organizationId, ownerWorkspaceId, "/ensure", { method: "POST", signal: input.signal });
  const deadline = Date.now() + 10 * 60_000;
  let shown = 0;
  for (;;) {
    input.signal?.throwIfAborted();
    const server = await linkedServerRequest<ServerDetail>(organizationId, ownerWorkspaceId, "", { signal: input.signal });
    if (!server.managed) throw new AppError("Managed server not found", 404, "SERVER_NOT_FOUND");
    const operation = server.managed.operation;
    const logs = operation?.logs ?? [];
    for (const message of logs.slice(shown)) input.onProgress?.(`${message}\n`);
    shown = logs.length;
    if (operation?.status === "failed")
      throw new AppError(operation.error ?? "Cloud could not prepare the server", 409, "CLOUD_SERVER_OPERATION_FAILED");
    if (!operation || operation.status === "succeeded") {
      const connection = await remoteServerConnection(organizationId, ownerWorkspaceId, true);
      if (input.existingWorkspaceId && connection.workspaceId !== input.existingWorkspaceId)
        throw new AppError("The managed server changed", 409, "CLOUD_SERVER_IDENTITY_MISMATCH");
      return connection.workspaceId;
    }
    if (Date.now() >= deadline)
      throw new AppError("The managed server is still being prepared. Check its activity and retry.", 504,
        "CLOUD_SERVER_PREPARATION_TIMEOUT");
    await delay(1_000, undefined, { signal: input.signal });
  }
}
