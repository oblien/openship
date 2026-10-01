import { repos, type Server } from "@repo/db";
import type { EdgeProviderOptions } from "@repo/adapters";
import { resolveAcmeProviderOptions } from "./acme-config";
import { isLocalHostRow } from "./box-org";
import { createProvisionLock } from "./provision-lock";

/** One lock per edge, shared by deploys, verification, TLS and server settings.
 * Separate from provisioning: setup may already hold the provisioning lock. */
export function edgeProviderOptions(remoteServerId?: string): EdgeProviderOptions {
  return {
    ...resolveAcmeProviderOptions(),
    configLock: createProvisionLock(
      remoteServerId ? `edge-config:server:${remoteServerId}` : "edge-config:local",
    ),
  };
}

/** Reuse an already-authorized row when available. Id-only callers also resolve
 * the local-host alias so every path selects the same edge lock. */
export async function resolveEdgeProviderOptions(
  target?: string | Server,
): Promise<EdgeProviderOptions> {
  if (!target) return edgeProviderOptions();
  const server = typeof target === "string" ? await repos.server.get(target) : target;
  if (!server) throw new Error(`Server not found: ${target}`);
  return edgeProviderOptions((await isLocalHostRow(server)) ? undefined : server.id);
}
