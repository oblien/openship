/**
 * Tunnel agent lifecycle — generic, provider-agnostic.
 *
 * Owns the in-process TunnelAgent for the currently active tunnel:
 *   - connect on demand
 *   - reconnect with exponential backoff on transient disconnect
 *   - cancel on stopAgent (called from SIGTERM/SIGINT, switch-back,
 *     or a new startAgent for a different tunnel)
 *
 * Today we hold a SINGLE agent — there's only ever one team-mode
 * tunnel per instance. When user-defined tunnels arrive we'll either
 * key this by tunnel id or spin up a manager per tunnel. The internal
 * shape (active + activeSession + reconnect chain) ports cleanly
 * either way.
 *
 * Ported from the original lib/tunnel-manager.ts; the differences are:
 *   - decoupled from the Oblien client and instance_settings reads
 *   - parameterized by TunnelProvider + TunnelRecord + port
 *   - safe to call startAgent for a DIFFERENT tunnel mid-flight
 *     (the old agent is stopped first)
 */

import { systemDebug } from "@repo/platform/engine/lib/system-debug";
import type { TunnelAgent, TunnelProvider, TunnelRecord } from "./types";

interface ActiveSession {
  provider: TunnelProvider;
  record: TunnelRecord;
  port: number;
}

let active: TunnelAgent | null = null;
let activeSession: ActiveSession | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 0;
let stopping = false;

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

function debug(msg: string): void {
  systemDebug("tunneling.manager", msg);
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function bumpBackoff(): number {
  backoffMs = backoffMs === 0
    ? MIN_BACKOFF
    : Math.min(MAX_BACKOFF, backoffMs * 2);
  return backoffMs;
}

function scheduleReconnect(reason: string): void {
  if (stopping || !activeSession) return;
  if (reconnectTimer) return;
  const delay = bumpBackoff();
  debug(`reconnect scheduled in ${delay}ms (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectOnce().catch((err) => {
      debug(`reconnect attempt failed: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect("reconnect-failed");
    });
  }, delay);
  // Don't keep the event loop alive solely for a reconnect timer —
  // graceful shutdown should still be able to exit.
  reconnectTimer.unref?.();
}

async function connectOnce(): Promise<void> {
  if (stopping || !activeSession) return;
  if (active?.isConnected) return;

  const { provider, record, port } = activeSession;
  debug(`connecting ${provider.name} agent slug=${record.slug} port=${port}`);
  const agent = await provider.connect(record, port);
  active = agent;
  backoffMs = 0;

  agent.on("disconnect", (code: number, reason: string) => {
    debug(`disconnect code=${code} reason=${reason}`);
    active = null;
    scheduleReconnect(`disconnect:${code}`);
  });
  agent.on("error", (err: Error) => {
    debug(`error: ${err.message}`);
    // Don't null `active` on transient errors — the socket may still
    // be alive. The disconnect listener fires if it actually drops.
  });
  agent.on("close", () => {
    debug("close event");
    active = null;
  });

  debug(`${provider.name} agent connected`);
}

/**
 * Start (or restart) the long-lived agent for the given tunnel record.
 * Idempotent for the same record — calling twice while connected is a
 * no-op. Calling with a DIFFERENT record stops the existing agent
 * first.
 */
export async function startAgent(
  provider: TunnelProvider,
  record: TunnelRecord,
  port: number,
): Promise<void> {
  if (
    active?.isConnected &&
    activeSession?.record.externalId === record.externalId &&
    activeSession?.port === port
  ) {
    debug("already connected to this tunnel — start is a no-op");
    return;
  }
  if (active || activeSession) {
    // Different tunnel/port? Stop the old session before swapping.
    stopAgent();
  }
  stopping = false;
  activeSession = { provider, record, port };
  try {
    await connectOnce();
  } catch (err) {
    debug(`initial connect failed: ${err instanceof Error ? err.message : String(err)}`);
    scheduleReconnect("initial-connect-failed");
  }
}

/**
 * Tear down the active agent and cancel any pending reconnect.
 * Safe to call when no agent is running.
 */
export function stopAgent(): void {
  stopping = true;
  clearReconnect();
  if (active) {
    debug("closing active agent");
    try {
      active.close();
    } catch (err) {
      debug(`close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    active = null;
  }
  activeSession = null;
}

export function isAgentConnected(): boolean {
  return active?.isConnected ?? false;
}
