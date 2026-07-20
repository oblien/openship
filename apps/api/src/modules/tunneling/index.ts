/**
 * Tunneling module — public surface.
 *
 * Generic primitives:
 *   - provisionTunnel(opts)  → create a tunnel record on a provider
 *   - teardownTunnel(opts)   → delete a tunnel record
 *   - startTunnelAgent(opts) → open the long-lived forwarding agent
 *   - stopTunnelAgent()      → close the agent + cancel reconnect
 *
 * Boot helpers (backwards-compatible with the old lib/tunnel-manager):
 *   - startTunnelIfConfigured() → boot-time auto-attach for team-mode
 *   - stopTunnel()              → SIGTERM / switch-back hook
 *   - isTunnelConnected()       → health probe
 *
 * Team-mode is the ONLY consumer today and it hard-codes provider
 * "oblien" inside startTunnelIfConfigured. When user-defined tunnels
 * arrive (separate PR), this file iterates over a `tunnels` table
 * row-by-row and starts an agent per row.
 */

import { DEFAULT_PORT } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { systemDebug } from "../../lib/system-debug";
import { resolveProvider } from "./registry";
import {
  isAgentConnected,
  startAgent,
  stopAgent,
} from "./manager";
import {
  ProviderNotReadyError,
  type TunnelProviderName,
  type TunnelRecord,
} from "./types";

export * from "./types";
export { resolveProvider, listProviders, describeProviders } from "./registry";

/* ─── Generic operations ───────────────────────────────────────── */

/**
 * Provision a new tunnel record on the chosen provider. Throws:
 *   - ProviderNotReadyError if preflight rejects (e.g. missing creds)
 *   - SlugTakenError if the chosen slug is in use
 *   - ProvisionFailedError on any other create failure
 *   - ProviderNotImplementedError for stub providers (cloudflare)
 *
 * Caller is responsible for persisting the returned TunnelRecord —
 * the tunneling module is intentionally stateless about ownership.
 */
export async function provisionTunnel(opts: {
  provider: TunnelProviderName;
  name: string;
  port: number;
  slug?: string;
  context?: Record<string, unknown>;
}): Promise<TunnelRecord> {
  const provider = resolveProvider(opts.provider);
  const pre = await provider.preflight();
  if (!pre.ok) {
    throw new ProviderNotReadyError(opts.provider, pre.reason);
  }
  return provider.create({
    name: opts.name,
    port: opts.port,
    slug: opts.slug,
    context: opts.context,
  });
}

/**
 * Permanently delete the tunnel record on the provider side.
 * Best-effort — providers should make delete idempotent so retry
 * after a partial failure works.
 */
export async function teardownTunnel(opts: {
  provider: TunnelProviderName;
  externalId: string;
}): Promise<void> {
  await resolveProvider(opts.provider).delete(opts.externalId);
}

/**
 * Start the in-process forwarding agent for a tunnel record.
 * Idempotent for the same record. Calling with a different record
 * stops the previous agent first.
 */
export async function startTunnelAgent(opts: {
  provider: TunnelProviderName;
  record: TunnelRecord;
  port: number;
}): Promise<void> {
  const provider = resolveProvider(opts.provider);
  await startAgent(provider, opts.record, opts.port);
}

/** Close the agent and cancel any pending reconnect timer. */
export function stopTunnelAgent(): void {
  stopAgent();
}

/** True while the agent holds a live socket to the provider's broker. */
export function isTunnelAgentConnected(): boolean {
  return isAgentConnected();
}

/* ─── Team-mode boot helpers ───────────────────────────────────── */

/* ─── Lifecycle (local-only by design) ────────────────────────────── */

/**
 * Lifecycle handle returned by attachTunnelingLifecycle. `stop()` is
 * sync, idempotent, safe to call on any cloud/local mode (it's a no-op
 * when no agent was started).
 */
export interface TunnelingLifecycle {
  /** Close the in-process agent and cancel any pending reconnect. */
  stop: () => void;
  /** True iff this process is hosting a tunneling agent right now. */
  attached: boolean;
}

const NOOP_LIFECYCLE: TunnelingLifecycle = Object.freeze({
  stop: () => {},
  attached: false,
});

/**
 * Attach the tunnel agent lifecycle to this process.
 *
 * One symbol for the whole story: CLOUD_MODE gate, team-mode lookup,
 * agent attach, returned stop closure. Boot site calls once, holds
 * the handle, calls `.stop()` on shutdown.
 *
 * LOCAL-API-ONLY BY DESIGN. The tunnel agent forwards broker traffic
 * to a port on THIS machine — SaaS has nothing to forward. When
 * CLOUD_MODE is set we return a frozen no-op handle without reading
 * instance_settings, resolving providers, or constructing any state.
 * This is the single enforcement point for the local/SaaS split on
 * the tunneling runtime.
 *
 * Resource provisioning (provisionTunnel/teardownTunnel) is unaffected
 * by this — those are outbound API calls to whichever provider owns
 * the resource and are safe to invoke from either side. Only the
 * agent's local runtime is gated here.
 */
export async function attachTunnelingLifecycle(): Promise<TunnelingLifecycle> {
  if (env.CLOUD_MODE) {
    systemDebug("tunneling", "CLOUD_MODE — agent lifecycle is local-only, not attaching");
    return NOOP_LIFECYCLE;
  }

  const settings = await repos.instanceSettings.get();
  if (settings?.teamMode !== "tunneled" || !settings.tunnelId) {
    systemDebug("tunneling", "not configured for tunnel mode — boot skipped");
    return NOOP_LIFECYCLE;
  }
  if (!settings.tunnelSlug || !settings.migrationTargetUrl) {
    systemDebug(
      "tunneling",
      "team-mode tunnel record incomplete (missing slug/url) — boot skipped",
    );
    return NOOP_LIFECYCLE;
  }

  await startTunnelAgent({
    provider: "oblien",
    record: {
      externalId: settings.tunnelId,
      slug: settings.tunnelSlug,
      publicUrl: settings.migrationTargetUrl,
    },
    port: DEFAULT_PORT.dashboard,
  });

  return {
    stop: stopTunnelAgent,
    attached: true,
  };
}
