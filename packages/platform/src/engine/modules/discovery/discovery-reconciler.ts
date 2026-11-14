/**
 * Discovery reconciler (docs/docker-service-discovery-plan.md, step 4).
 *
 * Consumes the scanner's desired-state queue and applies it to the serving
 * server's Openship Edge. Per enabled server, one pass:
 *
 *  1. WITHDRAWALS first — bindings flagged `withdrawalPending` (blocked or
 *     suppressed owners included): retire the application route, clear the
 *     flag. Blocking forbids forward applies; it never strands a live route.
 *  2. Due applies (pending/error, backoff elapsed, not suppressed):
 *     - missing/invalid/stopped observation → RETAIN the hostname as an
 *       unavailable vhost when a route was applied before: `return 503;` with
 *       TLS and both ACME challenge locations kept, so the certificate
 *       lifecycle continues and clients see "backend unavailable" instead of
 *       the default-server page (docs: "Retain an unavailable vhost with
 *       TLS/challenge handling while a backend is absent"). The domain row
 *       and certificate material stay. A binding that was never applied has
 *       no vhost to retain — plain removeRoute. Explicit withdrawal (blocked
 *       or suppressed owner, above) is full retirement, never retention.
 *     - observed+running → registerRoute against the resolved upstream:
 *       bridge-ip → `http://<ip>:<port>`; published-port → the container's
 *       observed loopback binding `http://127.0.0.1:<hostPort>` — a remote
 *       server's loopback is THAT server's, never the API host's, and the
 *       host-port claim subsystem proves ownership before anything dials it
 *       (the publish is OBSERVED from the container; no allocator runs).
 *       Registering over a retained unavailable vhost is the resume path.
 *  3. Success is `markApplied(desiredGeneration)` only after the edge write
 *     returned; the DB write alone is never "active". Failures persist
 *     backoff via markApplyError and retry on a later pass.
 *
 * Upstreams are probed from the routing provider's own network namespace, with
 * fresh container inspection before selection and before the route write.
 * Route repair from durable records lives in discovery-repair.ts; the sweep and
 * lifecycle watchers that drive both are step 5. The route writer is the
 * adapter's own `routing.registerRoute`; no project wrapper is faked (docs:
 * "must not call a wrapper that demands an active deployment").
 */
import { safeErrorMessage } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos, type DiscoveryBinding } from "@repo/db";
import { edgeProxyFor, type RoutingProvider, type Platform, type RuntimeAdapter } from "@repo/adapters";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import { manageDomainSsl } from "../../lib/domain-ssl";
import {
  resolveReachableDiscoveryUpstream,
  assertDiscoveryUpstreamCurrent,
  type DiscoveryInspectionRuntime,
} from "./discovery-upstream";
import {
  reserveObservedLoopbackPublishes,
  type ObservedLoopbackPublish,
  type ObservedHostPortRuntime,
} from "../deployments/observed-host-port-claims";
import {
  convergeTargetHostPortClaimsUnlocked,
  prepareTargetPinnedHostPorts,
  withHostPortTargetLock,
} from "../deployments/pinned-host-ports";
import {
  createPlatformForResolvedServer,
  disposePlatform,
  resolveServerExecutor,
  resolveServerHostPortTarget,
} from "../../lib/deployment-runtime";

/** Backoff for failed applies: 30s, 2m, 8m, then capped at 30m. */
const APPLY_BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000];

export interface DiscoveryEdgeTarget {
  routing: Pick<
    RoutingProvider,
    "registerRoute" | "removeRoute" | "probeUpstream" | "hasRoute" | "readRouteState"
  >;
  hostPortTarget: HostPortTargetIdentity | null;
  runtime?: ObservedHostPortRuntime & DiscoveryInspectionRuntime;
  /** Edge strict-inventory proxy for the loopback ownership guard. */
  edgeProxy: ReturnType<typeof edgeProxyFor> | null;
  dispose: () => Promise<void>;
}

/** Resolve the serving server's Edge context (routing + host-port identity). */
export async function resolveDiscoveryEdgeTarget(
  serverId: string,
  organizationId: string,
): Promise<DiscoveryEdgeTarget> {
  const resolved = await resolveServerExecutor(serverId, organizationId);
  const platform: Platform = await createPlatformForResolvedServer(resolved, "docker", organizationId);
  const hostPortTarget = await resolveServerHostPortTarget(resolved);
  const edgeProxy = resolved.executor
    ? edgeProxyFor(resolved.executor, "openresty", { ours: true })
    : null;
  return {
    routing: platform.routing,
    hostPortTarget,
    runtime: platform.runtime,
    edgeProxy,
    dispose: async () => {
      await disposePlatform(platform);
    },
  };
}

/** The upstream URL the binding's resolved strategy routes to. Null = withdraw. */
export function upstreamUrlFor(binding: DiscoveryBinding): string | null {
  if (binding.observationStatus === "missing" || binding.observationStatus === "invalid") return null;
  if (!binding.containerRunning) return null;
  if (binding.upstreamStrategy === "published-port") {
    if (!binding.hostPort) return null;
    const host = binding.hostIp === "::" ? "::1"
      : !binding.hostIp || binding.hostIp === "0.0.0.0" ? "127.0.0.1" : binding.hostIp;
    return `http://${host.includes(":") ? `[${host}]` : host}:${binding.hostPort}`;
  }
  if (binding.upstreamStrategy === "network-ip") {
    if (!binding.ipAddress) return null;
    return `http://${binding.ipAddress}:${binding.port}`;
  }
  return null;
}

/** Stable, FK-free claim owner for discovered published-port routes. */
function discoveryClaimOwner(binding: DiscoveryBinding): string {
  return `discovery:${binding.id}`;
}

/**
 * Retire one binding's route NOW (synchronous forget path): remove the vhost
 * and release this owner's published-port claims. Used by the server discovery
 * API's forget operation — the binding row is deleted by the caller AFTER this
 * succeeds, so a failed removal (edge down) leaves the binding intact for a
 * retry rather than stranding a route with no record.
 */
export async function retireBindingRoute(
  serverId: string,
  organizationId: string,
  binding: Pick<DiscoveryBinding, "hostname" | "id" | "serviceKey">,
  options?: { edge?: DiscoveryEdgeTarget },
): Promise<void> {
  const edge = options?.edge ?? (await resolveDiscoveryEdgeTarget(serverId, organizationId));
  const owned = !options?.edge;
  try {
    if (!edge.routing?.removeRoute) {
      throw new Error("server edge has no routing provider; is the Edge installed?");
    }
    await edge.routing.removeRoute(binding.hostname);
    await convergeDiscoveryClaims(edge, binding as DiscoveryBinding, []);
  } finally {
    if (owned) await edge.dispose();
  }
}

/**
 * Does THIS binding keep its hostname as an unavailable vhost (503 + TLS) when
 * its backend disappears — or does its route retire outright?
 *
 * Durable application history (`appliedGeneration > 0`) is the evidence a real
 * vhost exists: normal stop/removal observations requeue applied bindings as
 * `applyState: "pending"`, so the apply STATE cannot distinguish "never had a
 * route" from "had one and lost its backend" — only the generation record can.
 * Explicit control (suppressed owner, blocked declaration) always retires
 * fully: an operator opting out or a rejected declaration must not leave a
 * 503 vhost behind.
 */
export function shouldRetainUnavailableVhost(
  binding: Pick<DiscoveryBinding, "appliedGeneration" | "suppressed" | "applyState">,
): boolean {
  if (binding.suppressed || binding.applyState === "blocked") return false;
  return binding.appliedGeneration > 0;
}

/** The unavailable-vhost route shape for a retained hostname (503 + TLS + ACME). */
export function unavailableRouteFor(hostname: string) {
  return { domain: hostname, tls: true, terminatesTlsLocally: true, unavailable: true } as const;
}

/**
 * Release or re-pin this binding's host-port claims to exactly `desired`.
 * Runs under the target lock when the Edge context can support it (no target
 * identity or inventory = nothing this owner could have claimed, so it is a
 * no-op). A route switch from published-port to direct IP — or a withdrawal —
 * must converge with an EMPTY set, or the stale discovery-owned claim blocks
 * legitimate reuse of that host port forever.
 */
async function convergeDiscoveryClaims(
  edge: DiscoveryEdgeTarget,
  binding: DiscoveryBinding,
  desired: ObservedLoopbackPublish[],
): Promise<void> {
  const { hostPortTarget, edgeProxy } = edge;
  if (!hostPortTarget || !edgeProxy) return;
  await withHostPortTargetLock(hostPortTarget, async () => {
    await convergeTargetHostPortClaimsUnlocked({
      target: hostPortTarget,
      projectId: discoveryClaimOwner(binding),
      desiredPublishes: desired,
      edgeProxy,
    });
  });
}

/**
 * Fire-and-forget certificate reconciliation for a just-applied discovered
 * service (docs: "A start/replacement event triggers immediate certificate
 * reconciliation"). Provision reads before issuing, so a comfortably valid
 * certificate is reused without an order; a missing/due/expired one is issued
 * through the server-domain flow — whose fresh-inspection ACME gate refuses
 * (as a defer, not a failure) if the container stopped in between. ACME success
 * also establishes hostname verification for the server-scoped domain.
 */
async function scheduleServerDomainCert(
  serverId: string,
  organizationId: string,
  binding: DiscoveryBinding,
): Promise<void> {
  try {
    await manageDomainSsl(binding.hostname, {
      action: "provision",
      allowUnverified: true,
      serverId,
    });
  } catch (error) {
    // DiscoveryBackendUnavailableError = deferred (stop/gate), already recorded
    // by manageDomainSsl's failure path only when it is a real SSL failure.
    // Everything else is surfaced for diagnostics; the sweep and the next
    // start/replacement re-trigger this.
    reportCaughtError(error, "platform/engine/modules/discovery/discovery-reconciler");
  }
}

export interface DiscoveryReconcileSummary {
  withdrawals: string[];
  applied: string[];
  removed: string[];
  /** Hostnames switched to an unavailable vhost (backend absent, TLS kept). */
  retained: string[];
  failed: Array<{ serviceKey: string; reason: string }>;
  skipped: number;
  ok: boolean;
}

export async function reconcileServerDiscovery(
  serverId: string,
  organizationId: string,
  options?: {
    /** Injected Edge target (tests); resolves the server's own when omitted. */
    edge?: DiscoveryEdgeTarget;
  },
): Promise<DiscoveryReconcileSummary> {
  const summary: DiscoveryReconcileSummary = {
    withdrawals: [],
    applied: [],
    removed: [],
    retained: [],
    failed: [],
    skipped: 0,
    ok: false,
  };

  const settings = await repos.discovery.getSettings(serverId);
  // WITHDRAWALS run even when discovery is DISABLED: disable schedules route
  // retirement for every applied binding, and retiring those routes is the
  // one stage that must still run (docs: "Disable mode ... withdraws
  // discovery-owned application routes"). Scans, applies, and repair stay
  // gated on `enabled` (the sweep's other stages self-gate the same way).
  if (!settings) return summary;
  const enabled = settings.enabled === true;
  // With discovery off, no vhost is retained at all: disable withdraws
  // routes outright (explicit control at the server level).
  const retainUnavailable = enabled;

  const edge = options?.edge ?? (await resolveDiscoveryEdgeTarget(serverId, organizationId));
  const owned = !options?.edge;
  try {
    const routing = edge.routing;
    if (!routing?.registerRoute) {
      summary.failed.push({ serviceKey: "*", reason: "server edge has no routing provider; is the Edge installed?" });
      await repos.discovery.recordScan(serverId, { ok: false, error: "server edge has no routing provider" }).catch(() => {});
      return summary;
    }

    // ── Withdrawals first: retire live routes for blocked/suppressed owners ──
    // Also consumes observation-driven losses (markMissing/markInvalid flag
    // previously-applied bindings): those RETAIN the hostname instead of
    // dropping the vhost — the certificate lifecycle continues.
    for (const binding of await repos.discovery.dueForWithdrawal(serverId)) {
      try {
        if (retainUnavailable && shouldRetainUnavailableVhost(binding)) {
          await repos.domain.ensureServerDomain({
            serverId,
            hostname: binding.hostname,
            targetPort: binding.port,
          });
          await routing.registerRoute(unavailableRouteFor(binding.hostname));
          const retained = await repos.discovery.markWithdrawn(serverId, binding.serviceKey);
          if (retained) summary.retained.push(binding.serviceKey);
        } else {
          await routing.removeRoute(binding.hostname);
          const withdrawn = await repos.discovery.markWithdrawn(serverId, binding.serviceKey);
          if (withdrawn) summary.withdrawals.push(binding.serviceKey);
        }
        // Either way, this owner's published-port claims must release: a
        // withdrawal or retention leaves no dialing upstream behind.
        await convergeDiscoveryClaims(edge, binding, []);
      } catch (error) {
        summary.failed.push({ serviceKey: binding.serviceKey, reason: safeErrorMessage(error) });
      }
    }

    // ── Due applies (only while discovery is enabled) ─────────────────────
    if (!enabled) return { ...summary, ok: true };
    for (let binding of await repos.discovery.dueForApply(serverId)) {
      try {
        if (binding.observationStatus !== "observed" || !binding.containerRunning) {
          // Missing/invalid/stopped: the upstream is gone. A binding with
          // durable application history keeps its hostname as an unavailable
          // vhost (503 + TLS + ACME, existing certificate material) — the
          // TLS lifecycle continues and a returning container re-registers
          // over it. A binding that never applied has no vhost to retain;
          // plain removal. (Stop/removal observations requeue applied
          // bindings as applyState "pending" — the history record, not the
          // apply state, is what proves a vhost exists.)
          await convergeDiscoveryClaims(edge, binding, []);
          if (retainUnavailable && shouldRetainUnavailableVhost(binding)) {
            await repos.domain.ensureServerDomain({
              serverId,
              hostname: binding.hostname,
              targetPort: binding.port,
            });
            await routing.registerRoute(unavailableRouteFor(binding.hostname));
            const retained = await repos.discovery.markApplied(serverId, binding.serviceKey, binding.desiredGeneration);
            if (retained) summary.retained.push(binding.serviceKey);
          } else {
            await routing.removeRoute(binding.hostname);
            const withdrawn = await repos.discovery.markApplied(serverId, binding.serviceKey, binding.desiredGeneration);
            if (withdrawn) summary.removed.push(binding.serviceKey);
          }
          continue;
        }

        const selected = await resolveReachableDiscoveryUpstream(
          binding,
          edge.runtime,
          routing.probeUpstream?.bind(routing),
        );
        const resolved = await repos.discovery.resolveUpstream(binding, selected.target);
        if (!resolved) {
          summary.skipped++;
          continue; // A new scan, suppression, or block superseded this probe.
        }
        binding = resolved;
        const upstream = selected.targetUrl;
        const assertCurrent = async () => {
          const current = await repos.discovery.getBinding(serverId, binding.serviceKey);
          const enabled = await repos.discovery.getSettings(serverId);
          if (!enabled?.enabled || !current || current.desiredGeneration !== binding.desiredGeneration ||
              current.containerId !== binding.containerId || current.suppressed ||
              current.applyState === "blocked" || current.observationStatus !== "observed") {
            throw new Error("Discovery binding changed while probing; retry before applying the route");
          }
          await assertDiscoveryUpstreamCurrent(binding, selected, edge.runtime);
        };

        // The server-scoped domain row backs the TLS lifecycle (verification
        // flows, the renewal sweep, the cert scheduling below). Created here,
        // on apply — never by container configuration alone.
        await repos.domain.ensureServerDomain({
          serverId,
          hostname: binding.hostname,
          targetPort: binding.port,
        });

        if (binding.upstreamStrategy === "published-port") {
          // Loopback published route: prove workload ownership through the
          // host-port claim subsystem BEFORE dialing it (docs: "Use existing
          // observed-port ownership rules... do not invoke an allocator").
          // The publish is OBSERVED from the container inspect; the claim owner
          // is stable and FK-free (`discovery:<bindingId>`).
          const { hostPortTarget, edgeProxy } = edge;
          if (!hostPortTarget || !edgeProxy || !binding.hostPort) {
            throw new Error("published-port route requires a resolved host-port target, edge inventory, and observed host port");
          }
          const publishes: ObservedLoopbackPublish[] = [
            {
              serviceId: binding.serviceKey,
              containerId: binding.containerId ?? undefined,
              containerPort: binding.port,
              hostPort: binding.hostPort,
            },
          ];
          await withHostPortTargetLock(hostPortTarget, async () => {
            await assertCurrent();
            await prepareTargetPinnedHostPorts({
              target: hostPortTarget,
              edgeProxy,
            });
            await reserveObservedLoopbackPublishes({
              target: hostPortTarget,
              projectId: discoveryClaimOwner(binding),
              runtime: edge.runtime,
              publishes,
            });
            // Inventory/claim recovery can wait on the engine; do not write a
            // target that changed during that work, even if its TCP probe passed.
            await assertCurrent();
            await routing.registerRoute({
              domain: binding.hostname,
              targetUrl: upstream,
              tls: true,
              terminatesTlsLocally: true,
            });
            await convergeTargetHostPortClaimsUnlocked({
              target: hostPortTarget,
              projectId: discoveryClaimOwner(binding),
              desiredPublishes: publishes,
              edgeProxy,
            });
          });
        } else {
          // Bridge-IP direct route: no loopback, no NEW host-port claims — but
          // if an earlier generation of this binding routed via published-port,
          // its claims must be released or legitimate reuse of that port stays
          // blocked forever.
          await assertCurrent();
          await routing.registerRoute({
            domain: binding.hostname,
            targetUrl: upstream,
            tls: true,
            terminatesTlsLocally: true,
          });
          await convergeDiscoveryClaims(edge, binding, []);
        }

        const applied = await repos.discovery.markApplied(serverId, binding.serviceKey, binding.desiredGeneration);
        // A stale apply (newer generation desired meanwhile) must not be
        // reported as success: markApplied returns undefined when the desired
        // generation moved past this attempt, and the newer state remains queued.
        if (applied) summary.applied.push(binding.serviceKey);
        else summary.skipped += 1;
        // Immediate certificate reconciliation for the freshly (re-)applied
        // upstream. Deferred inside: the ACME gate re-inspects the container
        // fresh and defers (never fails the route) when it stopped meanwhile.
        void scheduleServerDomainCert(serverId, organizationId, binding)
      } catch (error) {
        reportCaughtError(error, "platform/engine/modules/discovery/discovery-reconciler");
        const reason = safeErrorMessage(error);
        summary.failed.push({ serviceKey: binding.serviceKey, reason });
        const attempts = binding.applyAttempts;
        const delay = APPLY_BACKOFF_MS[Math.min(attempts, APPLY_BACKOFF_MS.length - 1)];
        await repos.discovery
          .markApplyError(
            serverId,
            binding.serviceKey,
            reason,
            new Date(Date.now() + delay),
            // GENERATION-CONDITIONAL: a stale attempt failing after a newer
            // observation requeued the binding must not overwrite that pending
            // state or impose backoff on work never attempted at that generation.
            binding.desiredGeneration,
          )
          .catch(() => {});
      }
    }

    summary.ok = true;
    return summary;
  } finally {
    if (owned) await edge.dispose().catch(() => {});
  }
}

export type { RuntimeAdapter };
