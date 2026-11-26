import { CloudServerConnection, Oblien } from "@repo/adapters";
import { AppError } from "@repo/core";
import { getConnectionAccess } from "../modules/credentials/connection-authorization";
import { createProvisionLock } from "./provision-lock";

const isOblien = (provider: string): provider is "oblien" => provider === "oblien";

export async function connectedOblienVm(org: string, credentialId: string, boundVmId?: string) {
  const load = () => getConnectionAccess(org, credentialId, isOblien);
  const access = await load();
  const { vmId, namespace, authorization } = access.publicFields;
  if (
    !vmId ||
    typeof namespace !== "string" ||
    authorization !== "oauth" ||
    (boundVmId && vmId !== boundVmId)
  )
    throw new AppError("Reconnect this VM through Oblien.", 409, "OBLIEN_VM_BINDING_INVALID");
  const client = new Oblien({
    token: access.secrets.apiToken,
    baseUrl: "https://api.oblien.com/v2",
    tokenRefresh: {
      expiresAt: new Date(Number(access.secrets._expiresAt)).toISOString(),
      async refresh() {
        const next = await load();
        if (next.publicFields.vmId !== vmId || next.publicFields.namespace !== namespace)
          throw new AppError(
            "The authorized VM changed. Reconnect the server.",
            409,
            "OBLIEN_VM_BINDING_INVALID",
          );
        return {
          token: next.secrets.apiToken,
          expiresAt: new Date(Number(next.secrets._expiresAt)).toISOString(),
        };
      },
    },
  });
  return new CloudServerConnection(client, {
    customerOwned: true,
    workspaceId: vmId,
    namespace: namespace || null,
    bridgeLock: createProvisionLock(`cloud:docker-bridge:${vmId}`),
    provisionLock: createProvisionLock(`cloud:server:${vmId}`),
  });
}

export async function inspectOblienVm(org: string, credentialId: string) {
  const connection = await connectedOblienVm(org, credentialId);
  try {
    const vm = await connection.inspect();
    await (await connection.runtime()).info();
    return vm;
  } finally {
    await connection.dispose();
  }
}
