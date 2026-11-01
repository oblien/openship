import { createHash } from "node:crypto";
import { AppError } from "@repo/core";
import type { ServerDependencies } from "../../../servers";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import {
  managedConnection,
  mutateManagedServer,
  managedProviderCall,
  type ManagedConnection,
} from "./managed-server-access";

const normalizedEgress = (values: string[]) =>
  [...new Set(values.map((value) => value.toLowerCase()))].sort();

/** Project routing owns ingress/private links. Expose only safe diagnostics and
 * patch outbound fields without copying credentials or unrelated VM settings. */
async function readSettings(network: ManagedConnection["workspace"]["network"]) {
  const current = await network.get();
  const settings = {
    internetAccess: typeof current.allow_internet === "boolean" ? current.allow_internet : null,
    ingressPorts: Array.isArray(current.ingress_ports)
      ? current.ingress_ports.filter(
          (port): port is number =>
            Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535,
        )
      : [],
    ingressAll: Array.isArray(current.ingress_ports) && current.ingress_ports.includes("*"),
    egress:
      Array.isArray(current.egress) && current.egress.every((value) => typeof value === "string")
        ? normalizedEgress(current.egress as string[])
        : null,
    privateIp: typeof current.ip === "string" ? current.ip : null,
    outboundIp: typeof current.outbound_ip === "string" ? current.outbound_ip : null,
    outboundMode: typeof current.outbound_mode === "string" ? current.outbound_mode : null,
  };
  return {
    ...settings,
    revision: createHash("sha256")
      .update(JSON.stringify([settings.internetAccess, settings.egress]))
      .digest("hex"),
  };
}

/** Existing clients validate the original response strictly. Diagnostics are an
 * explicit read option; writes opt in by supplying the observed revision. */
function publicSettings(settings: Awaited<ReturnType<typeof readSettings>>, details = false) {
  return details
    ? settings
    : { internetAccess: settings.internetAccess, ingressPorts: settings.ingressPorts };
}

export const serverNetworkSettings: Pick<
  ServerDependencies["resources"],
  "getNetworkSettings" | "updateNetworkSettings"
> = {
  async getNetworkSettings(ctx, id, input) {
    const settings = await managedProviderCall(async () =>
      readSettings((await managedConnection(ctx, id)).workspace.network),
    );
    return publicSettings(settings, input?.details);
  },
  async updateNetworkSettings(ctx, id, input) {
    if (input.egress && !input.expectedRevision)
      throw new AppError(
        "Refresh the outbound rules before editing them",
        400,
        "SERVER_NETWORK_REVISION_REQUIRED",
      );
    if (input.egress && !input.internetAccess)
      throw new AppError(
        "Outbound rules require internet access to be enabled",
        400,
        "SERVER_NETWORK_RULES_DISABLED",
      );
    if (input.egress?.includes("*") && input.egress.length > 1)
      throw new AppError(
        "Use * alone to allow all destinations, or list specific hosts",
        400,
        "INVALID_OUTBOUND_RULES",
      );
    const settings = await managedProviderCall(() =>
      mutateManagedServer(ctx, id, input.internetAccess, async ({ workspace }) => {
        const network = workspace.network;
        const before = await readSettings(network);
        const desiredEgress = input.egress ? normalizedEgress(input.egress) : undefined;
        const egressMatches =
          desiredEgress === undefined ||
          JSON.stringify(before.egress) === JSON.stringify(desiredEgress);
        if (before.internetAccess === input.internetAccess && egressMatches) return before;
        if (
          before.internetAccess !== input.expectedInternetAccess ||
          (input.expectedRevision && input.expectedRevision !== before.revision)
        )
          throw new AppError(
            "Network settings changed. Refresh and review them before saving.",
            409,
            "SERVER_NETWORK_SETTINGS_CHANGED",
          );
        const result = await network.update({
          allow_internet: input.internetAccess,
          ...(desiredEgress ? { egress: desiredEgress } : {}),
        });
        if (result.success !== true)
          throw new AppError(
            "The provider could not update outbound internet access",
            502,
            "SERVER_NETWORK_UPDATE_FAILED",
          );
        const after = await readSettings(network);
        if (
          after.internetAccess !== input.internetAccess ||
          (desiredEgress && JSON.stringify(after.egress) !== JSON.stringify(desiredEgress))
        )
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
      }),
    );
    return publicSettings(settings, !!input.expectedRevision);
  },
};
