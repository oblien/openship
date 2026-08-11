/**
 * SSH port-forward tunnels controller — Desktop-only.
 *
 * Exposes VS Code-style port forwarding: map a remote server port to
 * `localhost:<port>` on the user's machine. Only meaningful in desktop mode
 * (the orchestrator IS the user's machine), so every handler is gated by
 * `assertDesktop` on top of the route-level `localOnly`. Config rows live in
 * `server_tunnels`; the live sockets live in `ssh-tunnel-manager`.
 *
 * Security: gated behind localOnly + assertDesktop + authMiddleware. Every
 * handler runs the permission resolver on the server resource AND an
 * org-scoped existence check, so out-of-org server / tunnel ids 404
 * indistinguishably from missing.
 */

import type { Context } from "hono";
import { repos, type ServerTunnel } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { assertNotCloud, assertDesktop } from "../../lib/controller-helpers";
import {
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  type TunnelStatus,
} from "../../lib/ssh-tunnel-manager";

/**
 * Run the shared guards for every tunnel handler: cloud/desktop mode, the
 * permission resolver, and the org-scoped server existence check. Returns the
 * verified serverId on success, or a Response to return immediately.
 */
async function guardServer(
  c: Context,
  action: "read" | "write",
): Promise<{ serverId: string } | Response> {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const desktopGuard = assertDesktop(c);
  if (desktopGuard) return desktopGuard;

  const serverId = c.req.param("id")!;
  const ctx = getRequestContext(c);
  // Primary gate: permission resolver (404 on deny, IDOR-safe).
  await permission.assert(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action,
  });
  // Org-scoped: out-of-org server ids 404 indistinguishably from missing.
  const server = await repos.server.getInOrganization(
    serverId,
    ctx.organizationId,
  );
  if (!server) return c.json({ error: "Server not found" }, 404);

  return { serverId };
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
export async function listTunnels(c: Context) {
  const guard = await guardServer(c, "read");
  if (guard instanceof Response) return guard;

  const rows = await repos.serverTunnel.listByServer(guard.serverId);
  return c.json(rows.map(serializeTunnel));
}

/** POST /servers/:id/tunnels — save a forward config (upsert). */
export async function saveTunnel(c: Context) {
  const guard = await guardServer(c, "write");
  if (guard instanceof Response) return guard;

  const body = await c.req.json().catch(() => ({}));

  const remotePort = parsePort(body.remotePort);
  if (remotePort === null) {
    return c.json({ error: "remotePort must be a port between 1 and 65535" }, 400);
  }
  const localPort =
    body.localPort === undefined || body.localPort === null
      ? null
      : parsePort(body.localPort, { allowZero: true });
  if (body.localPort !== undefined && body.localPort !== null && localPort === null) {
    return c.json({ error: "localPort must be 0 (auto) or a port between 1 and 65535" }, 400);
  }
  const remoteHost =
    typeof body.remoteHost === "string" && body.remoteHost.trim()
      ? body.remoteHost.trim()
      : "127.0.0.1";

  const row = await repos.serverTunnel.upsert({
    serverId: guard.serverId,
    remotePort,
    remoteHost,
    localPort,
    autoStart: body.autoStart === true,
  });

  return c.json(serializeTunnel(row), 201);
}

/**
 * Resolve a `:tunnelId` belonging to the verified server. Returns the config
 * row, or a Response (404) when the tunnel is missing or owned by another
 * server.
 */
async function getOwnedTunnel(
  c: Context,
  serverId: string,
): Promise<ServerTunnel | Response> {
  const tunnelId = c.req.param("tunnelId")!;
  const row = await repos.serverTunnel.get(tunnelId);
  if (!row || row.serverId !== serverId) {
    return c.json({ error: "Tunnel not found" }, 404);
  }
  return row;
}

/** POST /servers/:id/tunnels/:tunnelId/start — open the tunnel. */
export async function startTunnelHandler(c: Context) {
  const guard = await guardServer(c, "write");
  if (guard instanceof Response) return guard;
  const row = await getOwnedTunnel(c, guard.serverId);
  if (row instanceof Response) return row;

  let status: TunnelStatus;
  try {
    status = await startTunnel({
      tunnelId: row.id,
      serverId: row.serverId,
      remotePort: row.remotePort,
      remoteHost: row.remoteHost,
      preferredPort: row.localPort ?? row.remotePort,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start tunnel";
    return c.json({ error: message }, 502);
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
  return c.json(fresh ? serializeTunnel(fresh) : { ...status, url: `http://localhost:${status.localPort}` });
}

/** POST /servers/:id/tunnels/:tunnelId/stop — close the tunnel. */
export async function stopTunnelHandler(c: Context) {
  const guard = await guardServer(c, "write");
  if (guard instanceof Response) return guard;
  const row = await getOwnedTunnel(c, guard.serverId);
  if (row instanceof Response) return row;

  await stopTunnel(row.id);
  return c.json(serializeTunnel(row));
}

/** DELETE /servers/:id/tunnels/:tunnelId — remove the config (+ stop if live). */
export async function deleteTunnel(c: Context) {
  const guard = await guardServer(c, "write");
  if (guard instanceof Response) return guard;
  const row = await getOwnedTunnel(c, guard.serverId);
  if (row instanceof Response) return row;

  await stopTunnel(row.id);
  await repos.serverTunnel.remove(row.id);
  return c.json({ ok: true });
}
