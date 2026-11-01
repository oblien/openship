import { OperationError } from "@repo/contracts";
import type { ConnectedServer } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { tryWithProvisionLock } from "../../lib/provision-lock";
import { isLocalHostRow } from "../../lib/box-org";
import { requireConnectedServer } from "./server-access";
import { getActiveSetupSession } from "./setup-session";

/** Share deployment provisioning's lock across installers, removers and replicas.
 * The callback owns the lock until all host work finishes, including SSE work. */
export async function withServerProvisioning<T>(
  ctx: ExecutionContext,
  serverId: string,
  work: (server: ConnectedServer) => Promise<T>,
): Promise<T> {
  const permission = { resourceType: "server", resourceId: serverId, action: "admin" } as const;
  await authorization.authorize(ctx, permission);
  const target = await requireConnectedServer(ctx, serverId);
  const scope = (await isLocalHostRow(target)) ? "provision:local" : `provision:server:${serverId}`;
  const busy = () => {
    const session = getActiveSetupSession(serverId);
    return new OperationError("install_in_progress", 409, "install_in_progress", {
      error: "install_in_progress",
      ...(session ? { sessionId: session.id } : {}),
    });
  };
  const result = await tryWithProvisionLock(scope, async () => {
    await authorization.authorize(ctx, permission);
    const server = await requireConnectedServer(ctx, serverId);
    if (getActiveSetupSession(serverId)) throw busy();
    return { value: await work(server) };
  });
  if (!result) throw busy();
  return result.value;
}
