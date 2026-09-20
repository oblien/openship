/**
 * SSH port-forward operations — desktop and explicitly enabled native use.
 *
 * Preserves desktop port forwarding and allows an embedding host to opt into
 * loopback listeners. Shared operations authorize the server; this layer also
 * checks its organization and the tunnel's parent before using retained sockets.
 */

import type { ExecutionContext } from "../../../context";
import type { ResourceServices } from "../../../resource-operations";
import {
  AppError,
  OperationError,
  ServerResourceSchemas,
  type ServerOperations,
} from "@repo/contracts";
import { repos, type ServerTunnel } from "@repo/db";
import { resolvePlatformConfig } from "../../lib/platform-config";
import { authorization } from "../../lib/authorization";
import { requireSelfHostedServer, assertServerExecution } from "./server-access";
import { assertNativeLocalForwarding } from "../../native/execution-policy";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import {
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  type TunnelStatus,
} from "../../lib/ssh-tunnel-manager";

/**
 * Resource authorization has already run. Verify the mode and organization
 * before looking up any configured forward.
 */
async function guardServer(ctx: ExecutionContext, serverId: string) {
  const server = await requireSelfHostedServer(ctx, serverId);
  if (process.env.OPENSHIP_NATIVE !== "true" && resolvePlatformConfig().target !== "desktop")
    throw new OperationError("Not available in this mode", 404, "CAPABILITY_UNAVAILABLE");
  return { serverId, server };
}

/** Merge a config row with its live status into the client shape. */
function serializeTunnel(row: ServerTunnel) {
  const status = getTunnelStatus(row.id);
  return {
    id: row.id,
    serverId: row.serverId,
    remoteHost: row.remoteHost,
    remotePort: row.remotePort,
    // Configured/last-assigned preferred local port.
    localPort: row.localPort,
    autoStart: row.autoStart,
    running: status !== null,
    // Live port actually bound (the OS may have picked a different one) + the
    // ready-to-open URL, present only while the tunnel is up.
    activeConnections: status?.activeConnections ?? 0,
    url: status ? `http://localhost:${status.localPort}` : null,
  };
}

/** Parse + validate a TCP port from request input. */
function parsePort(v: unknown, { allowZero = false } = {}): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) return null;
  if (n === 0 && allowZero) return 0;
  if (n < 1 || n > 65535) return null;
  return n;
}

/** GET /servers/:id/tunnels — configured forwards + live status. */
async function listTunnels(ctx: ExecutionContext, id: string) {
  const guard = await guardServer(ctx, id);

  const rows = await repos.serverTunnel.listByServer(guard.serverId);
  return rows.map(serializeTunnel);
}

/** POST /servers/:id/tunnels — save a forward config (upsert). */
async function saveTunnel(
  ctx: ExecutionContext,
  id: string,
  body: Parameters<ServerOperations["saveTunnel"]>[1],
) {
  const guard = await guardServer(ctx, id);

  const remotePort = parsePort(body.remotePort);
  if (remotePort === null) {
    throw new OperationError(
      "remotePort must be a port between 1 and 65535",
      400,
      "INVALID_TUNNEL_PORT",
    );
  }
  const remoteHost =
    typeof body.remoteHost === "string" && body.remoteHost.trim()
      ? body.remoteHost.trim()
      : "127.0.0.1";

  // Distinguish "omitted" from "explicitly cleared": the Ports card always
  // sends localPort + autoStart, but the "Open on localhost" affordance sends
  // only remotePort. Fields the caller omits are preserved (below) so a quick
  // open can't wipe a forward's configured local port / auto-start.
  const localProvided = body.localPort !== undefined;
  const autoStartProvided = body.autoStart !== undefined;

  let localPort: number | null = null;
  if (localProvided) {
    localPort = body.localPort === null ? null : parsePort(body.localPort, { allowZero: true });
    if (body.localPort !== null && localPort === null) {
      throw new OperationError(
        "localPort must be 0 (auto) or a port between 1 and 65535",
        400,
        "INVALID_TUNNEL_PORT",
      );
    }
  }
  let autoStart = body.autoStart === true;

  if (!localProvided || !autoStartProvided) {
    const existing = await repos.serverTunnel.getByTarget(guard.serverId, remotePort, remoteHost);
    if (existing) {
      if (!localProvided) localPort = existing.localPort;
      if (!autoStartProvided) autoStart = existing.autoStart;
    }
  }

  const row = await repos.serverTunnel.upsert({
    serverId: guard.serverId,
    remotePort,
    remoteHost,
    localPort,
    autoStart,
  });

  record(ctx, id, row.id, "save");
  return serializeTunnel(row);
}

/**
 * Resolve a tunnel belonging to the verified server. Foreign and missing IDs
 * produce the same error.
 */
async function getOwnedTunnel(serverId: string, tunnelId: string): Promise<ServerTunnel> {
  const row = await repos.serverTunnel.get(tunnelId);
  if (!row || row.serverId !== serverId) {
    throw new OperationError("Tunnel not found", 404, "NOT_FOUND");
  }
  return row;
}

/** POST /servers/:id/tunnels/:tunnelId/start — open the tunnel. */
async function startTunnelHandler(ctx: ExecutionContext, id: string, input: { tunnelId: string }) {
  const guard = await guardServer(ctx, id);
  const row = await getOwnedTunnel(guard.serverId, input.tunnelId);
  assertNativeLocalForwarding();
  await assertServerExecution(guard.server);

  let status: TunnelStatus;
  try {
    status = await startTunnel({
      tunnelId: row.id,
      serverId: row.serverId,
      remotePort: row.remotePort,
      remoteHost: row.remoteHost,
      preferredPort: row.localPort ?? row.remotePort,
      assertAccess: async () => {
        const context = await authorization.authorize(ctx, {
          resourceType: "server",
          resourceId: id,
          action: "write",
        });
        await getOwnedTunnel(id, row.id);
        assertNativeLocalForwarding();
        await assertServerExecution(await requireSelfHostedServer(context, id));
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Failed to start tunnel";
    throw new OperationError(message, 502, "TUNNEL_START_FAILED");
  }

  // Remember the actually-assigned local port so the UI + auto-start reuse it.
  if (status.localPort !== row.localPort) {
    await repos.serverTunnel
      .upsert({
        serverId: row.serverId,
        remotePort: row.remotePort,
        remoteHost: row.remoteHost,
        localPort: status.localPort,
        autoStart: row.autoStart,
      })
      .catch(() => {});
  }

  const fresh = await repos.serverTunnel.get(row.id);
  record(ctx, id, row.id, "start");
  return fresh
    ? serializeTunnel(fresh)
    : { ...status, url: `http://localhost:${status.localPort}` };
}

/** POST /servers/:id/tunnels/:tunnelId/stop — close the tunnel. */
async function stopTunnelHandler(ctx: ExecutionContext, id: string, input: { tunnelId: string }) {
  const guard = await guardServer(ctx, id);
  const row = await getOwnedTunnel(guard.serverId, input.tunnelId);

  await stopTunnel(row.id);
  record(ctx, id, row.id, "stop");
  return serializeTunnel(row);
}

/** DELETE /servers/:id/tunnels/:tunnelId — remove the config (+ stop if live). */
async function deleteTunnel(ctx: ExecutionContext, id: string, input: { tunnelId: string }) {
  const guard = await guardServer(ctx, id);
  const row = await getOwnedTunnel(guard.serverId, input.tunnelId);

  await stopTunnel(row.id);
  await repos.serverTunnel.remove(row.id);
  record(ctx, id, row.id, "remove");
  return { ok: true };
}

function record(ctx: ExecutionContext, serverId: string, tunnelId: string, operation: string) {
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "server:write",
    resourceType: "server",
    resourceId: serverId,
    after: { tunnelId, operation },
  });
}

export const serverTunnelResources = {
  listTunnels,
  saveTunnel,
  startTunnel: startTunnelHandler,
  stopTunnel: stopTunnelHandler,
  removeTunnel: deleteTunnel,
} satisfies Pick<
  ResourceServices<typeof ServerResourceSchemas>,
  "listTunnels" | "saveTunnel" | "startTunnel" | "stopTunnel" | "removeTunnel"
>;
