/**
 * Live port-forward tunnels — Desktop-only.
 *
 * RAM-only registry of open forwards (a remote server port → localhost on the
 * user's machine). The durable config lives in `server_tunnels`
 * (`repos.serverTunnel`); this manager owns the live sockets. Modeled on
 * terminal-session-manager: a module-singleton Map, no per-process persistence
 * (the sockets die with the process; `auto_start` rows are re-opened at boot by
 * the startup hook below).
 *
 * Retain fix: `tunnelForward()` opens local sockets over the pooled SSH
 * connection but never `retain()`s it, so an idle (no-traffic) tunnel could
 * have its SSH connection idle-dropped out from under it. This manager holds a
 * `retain()` for each live tunnel and `release()`s on stop, pinning the
 * connection for the tunnel's whole lifetime.
 */
import { repos } from "@repo/db";
import { tunnelForward, type ForwardHandle } from "./ssh-tunnel";
import { sshManager } from "./ssh-manager";
import { registerStartupHook } from "./startup/index";
import { withKeyedMutex } from "./provision-lock";
import { AppError } from "@repo/contracts";

interface LiveTunnel {
  tunnelId: string;
  serverId: string;
  remoteHost: string;
  remotePort: number;
  handle: ForwardHandle;
  accessTimer?: ReturnType<typeof setTimeout>;
}

export interface TunnelStatus {
  tunnelId: string;
  serverId: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  activeConnections: number;
}

const live = new Map<string, LiveTunnel>();
const starts = new Set<Promise<TunnelStatus>>();
const accessChecks = new Set<Promise<void>>();
let stopping = false;
let stoppingPromise: Promise<void> | undefined;

function toStatus(t: LiveTunnel): TunnelStatus {
  return {
    tunnelId: t.tunnelId,
    serverId: t.serverId,
    remoteHost: t.remoteHost,
    remotePort: t.remotePort,
    localPort: t.handle.localPort,
    activeConnections: t.handle.activeConnections,
  };
}

/**
 * Start (or return the already-running) tunnel for a config row. The pooled
 * SSH connection is `retain()`ed before forwarding and released on the error
 * path, so a failed start never leaks a hold.
 */
export function startTunnel(args: {
  tunnelId: string;
  serverId: string;
  remotePort: number;
  remoteHost?: string;
  preferredPort?: number;
  /** Recheck persisted access before binding, accepting a connection, and while live. */
  assertAccess?: () => Promise<void>;
}): Promise<TunnelStatus> {
  if (stopping) return Promise.reject(new AppError("Tunnels are closing", 503, "PLATFORM_CLOSING"));
  const assertAccess = args.assertAccess ? () => {
    if (stopping) return Promise.reject(new AppError("Tunnels are closing", 503, "PLATFORM_CLOSING"));
    const check = Promise.resolve().then(args.assertAccess);
    accessChecks.add(check);
    void check.then(() => accessChecks.delete(check), () => accessChecks.delete(check));
    return check;
  } : undefined;
  const work = withKeyedMutex(`tunnel:${args.tunnelId}`, async () => {
    if (stopping) throw new AppError("Tunnels are closing", 503, "PLATFORM_CLOSING");
    await assertAccess?.();
    const existing = live.get(args.tunnelId);
    if (existing) return toStatus(existing);

    const remoteHost = args.remoteHost ?? "127.0.0.1";

    // Pin the pooled SSH connection for the tunnel's lifetime.
    sshManager.retain(args.serverId);
    let handle: ForwardHandle;
    try {
      handle = await tunnelForward(args.serverId, args.remotePort, {
        remoteHost,
        preferredPort: args.preferredPort ?? args.remotePort,
        beforeConnect: assertAccess,
      });
    } catch (err) {
      sshManager.release(args.serverId);
      throw err;
    }

    const t: LiveTunnel = {
      tunnelId: args.tunnelId,
      serverId: args.serverId,
      remoteHost,
      remotePort: args.remotePort,
      handle,
    };
    live.set(args.tunnelId, t);
    if (assertAccess) {
      const check = async () => {
        try {
          await assertAccess();
        } catch {
          if (live.get(t.tunnelId) === t) await stopTunnel(t.tunnelId).catch(() => {});
          return;
        }
        if (live.get(t.tunnelId) === t) {
          t.accessTimer = setTimeout(() => {
            void check();
          }, 1000);
          t.accessTimer.unref?.();
        }
      };
      t.accessTimer = setTimeout(() => {
        void check();
      }, 1000);
      t.accessTimer.unref?.();
    }
    return toStatus(t);
  });
  starts.add(work);
  void work.then(
    () => starts.delete(work),
    () => starts.delete(work),
  );
  return work;
}

/** Stop a live tunnel. Idempotent — a no-op if it isn't running. */
export async function stopTunnel(tunnelId: string): Promise<void> {
  return withKeyedMutex(`tunnel:${tunnelId}`, async () => {
    const t = live.get(tunnelId);
    if (!t) return;
    // Delete first so a concurrent stop can't double-release the SSH hold.
    live.delete(tunnelId);
    clearTimeout(t.accessTimer);
    try {
      await t.handle.close();
    } finally {
      sshManager.release(t.serverId);
    }
  });
}

/** Status of one live tunnel, or null if it isn't running. */
export function getTunnelStatus(tunnelId: string): TunnelStatus | null {
  const t = live.get(tunnelId);
  return t ? toStatus(t) : null;
}

/** Status of every live tunnel for a server. */
export function listTunnelStatus(serverId: string): TunnelStatus[] {
  const out: TunnelStatus[] = [];
  for (const t of live.values()) {
    if (t.serverId === serverId) out.push(toStatus(t));
  }
  return out;
}

/** Close every live tunnel — graceful shutdown. */
export function stopAllTunnels(): Promise<void> {
  if (stoppingPromise) return stoppingPromise;
  stopping = true;
  return stoppingPromise = (async () => {
    await Promise.allSettled([...starts]);
    const ids = [...live.keys()];
    await Promise.all(ids.map((id) => stopTunnel(id).catch(() => {})));
    // A periodic check or accepted socket may already be reading the database.
    // Let it finish before the owner closes authorization/storage resources.
    while (accessChecks.size) await Promise.allSettled([...accessChecks]);
  })().finally(() => {
    stopping = false;
    stoppingPromise = undefined;
  });
}

/**
 * Register the desktop boot hook that re-opens every saved auto-start tunnel.
 *
 * Desktop-only (`modes: ["desktop"]`); the startup registry no-ops it under
 * any other target. Each tunnel is started in the background (fire-and-forget,
 * per-tunnel catch) so an unreachable server can't stall API boot — the hook
 * returns as soon as the starts are dispatched.
 */
export function registerTunnelAutostart(): void {
  registerStartupHook({
    id: "tunnels:autostart",
    modes: ["desktop"],
    run: async () => {
      const rows = await repos.serverTunnel.listAutoStart();
      if (rows.length === 0) return;
      console.log(`[startup] re-opening ${rows.length} port-forward tunnel(s)`);
      for (const row of rows) {
        void startTunnel({
          tunnelId: row.id,
          serverId: row.serverId,
          remotePort: row.remotePort,
          remoteHost: row.remoteHost,
          preferredPort: row.localPort ?? row.remotePort,
        }).catch((err) => console.warn(`[startup] tunnel ${row.id} failed to open:`, err));
      }
    },
  });
}
