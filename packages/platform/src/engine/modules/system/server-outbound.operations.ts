import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { AppError } from "@repo/core";
import type { ManagedOutbound } from "@repo/contracts";
import { isPrivateIp } from "@repo/adapters/outbound-target";
import type { ServerDependencies } from "../../../servers";
import { env } from "../../config/env";
import { getAdminOblienClient } from "../../lib/oblien-user-client";
import { linkedServerRequest } from "../../lib/cloud/server-link";
import {
  auditManagedControl,
  managedConnection,
  managedWorkspaceId,
  mutateManagedServer,
  requireProviderSuccess,
  type ManagedConnection,
} from "./managed-server-access";

async function readOutbound(connection: ManagedConnection): Promise<ManagedOutbound> {
  const current = await connection.workspace.network.get();
  const mode =
    current.outbound_mode === "custom" || current.outbound_mode === "managed"
      ? current.outbound_mode
      : null;
  const raw = current.outbound_proxy;
  const proxy =
    mode === "custom" &&
    raw &&
    isIPv4(raw.host) &&
    Number.isInteger(raw.port) &&
    raw.port > 0 &&
    raw.port <= 65535 &&
    (raw.protocol === "http" || raw.protocol === "https") &&
    typeof raw.has_credentials === "boolean"
      ? {
          host: raw.host,
          port: raw.port,
          protocol: raw.protocol,
          hasCredentials: raw.has_credentials,
        }
      : null;
  const settings = {
    mode,
    ip:
      typeof current.outbound_ip === "string" && isIPv4(current.outbound_ip)
        ? current.outbound_ip
        : null,
    countryCode:
      typeof current.outbound_country_code === "string" &&
      /^[A-Z]{2}$/.test(current.outbound_country_code)
        ? current.outbound_country_code
        : null,
    proxy,
  };
  // The provider advances updated_at for custom credential replacement. Public
  // host/port alone cannot fence two edits that change only the hidden password.
  const updatedAt = connection.provider.workspace.updated_at;
  const verified =
    mode &&
    (mode !== "custom" || proxy) &&
    typeof updatedAt === "string" &&
    Number.isFinite(Date.parse(updatedAt));
  return {
    ...settings,
    revision: verified
      ? createHash("sha256")
          .update(JSON.stringify([connection.binding.workspaceId, updatedAt, settings]))
          .digest("hex")
      : null,
  };
}

async function availableIps() {
  const client = getAdminOblienClient();
  if (!client)
    throw new AppError(
      "Read outbound choices through the connected Cloud server",
      409,
      "CLOUD_SERVER_REQUIRED",
    );
  return (await client.listOutboundIps()).filter(({ ip }) => isIPv4(ip) && !isPrivateIp(ip));
}

function assertProxyHost(host: string) {
  if (!isIPv4(host) || isPrivateIp(host))
    throw new AppError(
      "Use a public IPv4 address for the proxy. Hostnames and private addresses are not supported.",
      400,
      "INVALID_OUTBOUND_PROXY_HOST",
    );
}

/** Never expose provider messages: failed proxy requests can contain credentials. */
async function applyProxy(work: () => Promise<unknown>) {
  try {
    return await work();
  } catch (error) {
    // diagnostics-ignore: Only fixed public codes cross this secret-bearing boundary; managedProviderCall handles all other failures.
    const rawCode = (error as { code?: unknown })?.code;
    const code = typeof rawCode === "string" ? rawCode.toLowerCase() : null;
    if (code === "plan_required")
      throw new AppError(
        "Custom outbound proxies are not enabled on the Cloud provider account. Contact Openship support.",
        402,
        "MANAGED_PROXY_UNAVAILABLE",
      );
    if (
      code &&
      /^(invalid_.*proxy|invalid_proxy_.*|reserved_proxy_host|missing_custom_proxy|preflight_.*|proxy_.*)$/.test(
        code,
      )
    )
      throw new AppError(
        "The provider could not validate this proxy. Check its address, port, protocol and credentials, then retry.",
        400,
        "MANAGED_PROXY_REJECTED",
      );
    throw error;
  }
}

export const serverOutboundControls: Pick<
  ServerDependencies["resources"],
  "managedOutbound" | "managedOutboundOptions" | "setManagedOutbound"
> = {
  async managedOutbound(ctx, id) {
    if (!env.CLOUD_MODE)
      return linkedServerRequest(
        ctx.organizationId,
        await managedWorkspaceId(ctx, id),
        "/managed/outbound",
      );
    return readOutbound(await managedConnection(ctx, id));
  },
  async managedOutboundOptions(ctx, id) {
    if (!env.CLOUD_MODE)
      return linkedServerRequest(
        ctx.organizationId,
        await managedWorkspaceId(ctx, id),
        "/managed/outbound/options",
      );
    // Verify the owned server before using the provider's account-scoped pool.
    await managedConnection(ctx, id);
    return { ips: await availableIps() };
  },
  async setManagedOutbound(ctx, id, input) {
    if (!env.CLOUD_MODE)
      return linkedServerRequest(
        ctx.organizationId,
        await managedWorkspaceId(ctx, id),
        "/managed/outbound",
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      );
    if (input.mode === "custom") assertProxyHost(input.proxy.host);
    return mutateManagedServer(ctx, id, true, async (connection) => {
      const before = await readOutbound(connection);
      if (
        input.mode === "managed" &&
        before.mode === "managed" &&
        before.revision &&
        before.ip &&
        (input.ip === undefined || input.ip === before.ip)
      )
        return before;
      if (!before.revision)
        throw new AppError(
          "Outbound settings could not be verified. Refresh before changing them.",
          409,
          "SERVER_OUTBOUND_UNAVAILABLE",
        );
      if (before.revision !== input.expectedRevision)
        throw new AppError(
          "Outbound settings changed. Refresh and review them before saving.",
          409,
          "SERVER_OUTBOUND_CHANGED",
        );
      const network = connection.workspace.network;
      let expectedIp = input.mode === "custom" ? input.proxy.host : input.ip;
      if (input.mode === "managed" && input.ip) {
        if (!(await availableIps()).some(({ ip }) => ip === input.ip))
          throw new AppError(
            "This outbound address is no longer available. Refresh the available addresses.",
            409,
            "SERVER_OUTBOUND_IP_UNAVAILABLE",
          );
        // This provider endpoint returns {ip, mode}, without a success flag.
        await applyProxy(() => network.applyOutboundIp({ ip: input.ip! }));
      } else {
        const result = await applyProxy(() =>
          input.mode === "custom"
            ? network.setCustomProxy(input.proxy)
            : network.clearCustomProxy(),
        );
        requireProviderSuccess(result);
        if (input.mode === "managed") {
          const outbound = (result as { outbound?: { ip?: unknown } }).outbound;
          expectedIp =
            typeof outbound?.ip === "string" && isIPv4(outbound.ip) ? outbound.ip : undefined;
        }
      }
      const after = await readOutbound(await managedConnection(ctx, id));
      const confirmed =
        after.revision &&
        after.mode === input.mode &&
        expectedIp &&
        after.ip === expectedIp &&
        (input.mode === "managed"
          ? true
          : after.revision !== before.revision &&
            after.proxy?.host === input.proxy.host &&
            after.proxy.port === input.proxy.port &&
            after.proxy.protocol === input.proxy.protocol &&
            after.proxy.hasCredentials === "username" in input.proxy);
      if (!confirmed)
        throw new AppError(
          "The outbound change could not be confirmed. Refresh the current settings before retrying.",
          502,
          "SERVER_OUTBOUND_UNCONFIRMED",
        );
      auditManagedControl(ctx, id, "network.outbound", { before, after });
      return after;
    });
  },
};
