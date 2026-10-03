import type { Context } from "hono";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import type { ManagedServerActivityInput } from "@repo/contracts";
import { cloudWorkspaceStatus } from "@repo/adapters";
import { workspaceForServer } from "@repo/platform/engine/lib/cloud-workspace-scope";
import { readCloudWorkspaceHost } from "@repo/platform/engine/lib/cloud-workspace-host";
import { issueNamespaceToken } from "@repo/platform/engine/lib/openship-cloud";
import { assertManagedServerCanWork } from "@repo/platform/engine/lib/cloud-workspace-access";
import { getRequestContext } from "../../lib/request-context";

async function selected(c: Context) {
  const ctx = getRequestContext(c);
  // Resource authorization may select a different organization for a browser.
  // A linked installation must keep the exact organization it connected to.
  if (c.req.header("X-Organization-Id") !== ctx.organizationId)
    throw new AppError("The managed server is outside this Cloud connection", 404, "SERVER_NOT_FOUND");
  const { server, workspace } = await workspaceForServer(ctx.organizationId, c.req.param("id")!);
  if (!workspace || workspace.remote || workspace.deletionInProgress)
    throw new AppError("Managed server not found", 404, "SERVER_NOT_FOUND");
  return { ctx, server, workspace };
}

/** Cloud is the single admission authority even when another installation owns
 * the project records. Claims never expire while disconnected work may continue. */
export async function claimCloudServerActivity(c: Context) {
  const { ctx, workspace } = await selected(c);
  const input = await c.req.json<ManagedServerActivityInput>();
  const activity = await repos.cloudWorkspace.claimActivity(workspace.id, ctx.organizationId, {
    id: input.id, scope: input.scope, controllerId: `${ctx.userId}:${input.controllerId}`, startedAt: new Date().toISOString(),
  }, false, input.projects);
  return c.json({ id: activity.id });
}

export async function releaseCloudServerActivity(c: Context) {
  const ctx = getRequestContext(c);
  if (c.req.header("X-Organization-Id") !== ctx.organizationId)
    throw new AppError("Managed server not found", 404, "SERVER_NOT_FOUND");
  const { workspace } = await workspaceForServer(ctx.organizationId, c.req.param("id")!);
  if (!workspace || workspace.remote) throw new AppError("Managed server not found", 404, "SERVER_NOT_FOUND");
  const input = await c.req.json<ManagedServerActivityInput>();
  await repos.cloudWorkspace.releaseActivity(workspace.id, ctx.organizationId, input.id, `${ctx.userId}:${input.controllerId}`, input.projects);
  return c.json({ id: input.id, released: true });
}

/** Server permissions cannot resolve a deleted row. Organization billing
 * administration plus the exact operation key authorizes its durable receipt. */
export async function cloudServerDeletion(c: Context) {
  const ctx = getRequestContext(c);
  if (c.req.header("X-Organization-Id") !== ctx.organizationId)
    throw new AppError("Deletion confirmation not found", 404, "CLOUD_SERVER_DELETION_NOT_FOUND");
  const receipt = await repos.cloudWorkspace.findDeletion(c.req.param("id")!, ctx.organizationId, c.req.query("operationId")!);
  if (!receipt) throw new AppError("Deletion confirmation not found", 404, "CLOUD_SERVER_DELETION_NOT_FOUND");
  return c.json({ serverId: receipt.serverId, workspaceId: receipt.workspaceId, operationId: receipt.operationId, deletedAt: receipt.deletedAt.toISOString() });
}

/** Verifies host administration before a local installation stores a server link. */
export async function authorizeCloudServer(c: Context) {
  const { ctx, server, workspace } = await selected(c);
  return c.json({ userId: ctx.userId, organizationId: ctx.organizationId, serverId: server.id, workspaceId: workspace.id });
}

/** Namespace tokens never carry reseller authority. Reads cannot provision a VM;
 * workload admission additionally checks the subscription at its source. */
export async function cloudServerConnection(c: Context) {
  const { ctx, server, workspace } = await selected(c);
  const body = await c.req.json<{ work: boolean }>();
  if (body.work) await assertManagedServerCanWork(ctx.organizationId, workspace.id);
  const host = await readCloudWorkspaceHost(ctx.organizationId, workspace.id);
  if (!host.binding?.workspaceId || !host.provider)
    throw new AppError("The managed server is not ready yet", 409, "CLOUD_WORKSPACE_NOT_READY");
  const credentials = await issueNamespaceToken(ctx.organizationId, workspace.id);
  if (credentials.namespace !== host.binding.namespace)
    throw new AppError("The managed server's namespace changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  c.header("Cache-Control", "no-store");
  return c.json({
    userId: ctx.userId, organizationId: ctx.organizationId,
    serverId: server.id, ownerWorkspaceId: workspace.id,
    workspaceId: host.binding.workspaceId, image: host.binding.image,
    resources: host.provider.allocation, state: cloudWorkspaceStatus(host.provider.workspace),
    ...credentials,
  });
}
