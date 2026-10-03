import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { ServerDependencies } from "../../../servers";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { readCloudWorkspaceConnection } from "../../lib/cloud-workspace-host";
import { withCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";

async function managedServer(ctx: ExecutionContext, id: string) {
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new NotFoundError("Server", id);
  if (!server.workspaceId)
    throw new AppError(
      "Network settings are managed by this server's owner",
      409,
      "SERVER_NETWORK_SETTINGS_UNAVAILABLE",
    );
  return server.workspaceId;
}

async function networkFor(ctx: ExecutionContext, workspaceId: string) {
  const { client, binding } = await readCloudWorkspaceConnection(ctx.organizationId, workspaceId);
  return client.workspace(binding.workspaceId!).network;
}

/** Expose only the supported provider fields. Routes own ingress and private
 * connectivity; neither can be overwritten by a server settings form. */
async function readSettings(network: Awaited<ReturnType<typeof networkFor>>) {
  const current = await network.get();
  return {
    internetAccess: typeof current.allow_internet === "boolean" ? current.allow_internet : null,
    ingressPorts: Array.isArray(current.ingress_ports)
      ? current.ingress_ports.filter(
          (port): port is number =>
            Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535,
        )
      : [],
  };
}

export const serverNetworkSettings: Pick<
  ServerDependencies["resources"],
  "getNetworkSettings" | "updateNetworkSettings"
> = {
  async getNetworkSettings(ctx, id) {
    return readSettings(await networkFor(ctx, await managedServer(ctx, id)));
  },
  async updateNetworkSettings(ctx, id, input) {
    const workspaceId = await managedServer(ctx, id);
    return withCloudWorkspaceActivity(workspaceId, async () => {
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: id,
        action: "admin",
      });
      const network = await networkFor(ctx, workspaceId);
      const before = await readSettings(network);
      if (before.internetAccess === input.internetAccess) return before;
      if (before.internetAccess !== input.expectedInternetAccess)
        throw new AppError(
          "Network settings changed. Refresh and review them before saving.",
          409,
          "SERVER_NETWORK_SETTINGS_CHANGED",
        );
      const result = await network.update({ allow_internet: input.internetAccess });
      if (result.success === false)
        throw new AppError(
          "The provider could not update outbound internet access",
          502,
          "SERVER_NETWORK_UPDATE_FAILED",
        );
      const after = await readSettings(network);
      if (after.internetAccess !== input.internetAccess)
        throw new AppError(
          "The network change could not be confirmed. Refresh to check the provider's current settings.",
          502,
          "SERVER_NETWORK_UPDATE_UNCONFIRMED",
        );
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "server:admin",
        resourceType: "server",
        resourceId: id,
        before,
        after,
      });
      return after;
    });
  },
};
