import type { RuntimeAdapter } from "@repo/adapters";

/**
 * The single place that decides what `proxy_pass` target the OpenResty edge uses
 * for an app/service. Every route-registration site funnels through here so the
 * strategy can never drift.
 *
 *   - "loopback-port" (default): the app is published on a pinned LOOPBACK host
 *     port; the edge dials `127.0.0.1:<hostPort>`. Stable across restart, never
 *     internet-facing. Bare apps already own `127.0.0.1:<appPort>` (no hostPort
 *     needed). A routed service with NO published host port (internal compose
 *     service) transparently falls back to the container IP below.
 *   - "container-ip" (advanced): the edge dials the container's bridge IP —
 *     today's behavior. Enables zero-downtime overlap but is churn-prone and
 *     unreachable on Docker Desktop.
 */
export type RouteStrategy = "loopback-port" | "container-ip";

/** Concrete route strategies, plus "auto" (resolves to a concrete one). */
export type RouteStrategySetting = RouteStrategy | "auto";

type UpstreamRuntime = Pick<RuntimeAdapter, "supports" | "getContainerIp">;

/** Runtime surface needed to read a container's CURRENT publishing. */
type LiveUpstreamRuntime = UpstreamRuntime &
  Pick<RuntimeAdapter, "name"> & { getContainerInfo?: RuntimeAdapter["getContainerInfo"] };

/**
 * Last-known upstream for a container, as persisted on `service_deployment`.
 * A CACHE of a past live read — never authoritative on its own.
 */
export interface StoredUpstream {
  ip?: string | null;
  hostPort?: number | null;
}

export interface ResolveUpstreamArgs {
  strategy: RouteStrategy;
  runtime: UpstreamRuntime;
  containerId: string;
  /** Port the app listens on (inside the container / bare process). */
  containerPort: number;
  /** Pinned loopback host port, when the workload publishes one. */
  hostPort?: number | null;
}

/**
 * The PURE upstream-URL core — the single source of truth for the proxy_pass
 * target string. loopback-port with a host port → `127.0.0.1:<hostPort>`;
 * otherwise `<ip>:<containerPort>` (null when the ip is unknown). Callers that
 * already hold the ip + hostPort (routing-API sites reading persisted
 * `service_deployment.{ip,hostPort}`) use this directly; the runtime-aware
 * `resolveUpstreamUrl` resolves the ip first, then delegates here — so every
 * route-registration site funnels through ONE function, no fork.
 */
export function buildUpstreamUrl(args: {
  strategy: RouteStrategy;
  ip?: string | null;
  hostPort?: number | null;
  containerPort: number;
}): string | null {
  if (args.strategy === "loopback-port" && args.hostPort) {
    return `http://127.0.0.1:${args.hostPort}`;
  }
  return args.ip ? `http://${args.ip}:${args.containerPort}` : null;
}

export async function resolveUpstreamUrl(args: ResolveUpstreamArgs): Promise<string | null> {
  const { strategy, runtime, containerId, containerPort, hostPort } = args;

  // Loopback-port: dial the pinned host port when there is one. (Bare has no
  // hostPort — it falls through below, where bare's getContainerIp returns
  // 127.0.0.1, i.e. the same 127.0.0.1:<appPort>.)
  if (strategy === "loopback-port" && hostPort) {
    return `http://127.0.0.1:${hostPort}`;
  }
  const ip = runtime.supports("containerIp") ? await runtime.getContainerIp(containerId) : "127.0.0.1";
  return buildUpstreamUrl({ strategy, ip, hostPort, containerPort });
}

/**
 * Does the container publish a host port RIGHT NOW?
 *
 * `known:false` means "we could not ask" — an unreachable daemon, or a runtime
 * that can't inspect. That is NOT the same as "publishes nothing", and every
 * call site used to conflate the two by writing `info?.hostPort ?? row.hostPort`:
 * a live read that answered "no binding" fell straight through to a stored port
 * the container no longer had, so the edge kept dialing a dead
 * `127.0.0.1:<port>`. That is how a same-server migration left a healthy app
 * unreachable behind a Verified domain (#506).
 */
async function readLiveHostPort(
  runtime: LiveUpstreamRuntime,
  containerId: string,
  strategy: RouteStrategy,
): Promise<{ known: boolean; hostPort?: number }> {
  // container-ip never dials a host port, and a bare workload owns
  // `127.0.0.1:<appPort>` outright — neither has a publish to read.
  if (strategy !== "loopback-port" || runtime.name === "bare") return { known: true };
  if (!runtime.getContainerInfo || !runtime.supports("containerInfo")) return { known: false };
  try {
    const info = await runtime.getContainerInfo(containerId);
    // A `missing` container answers too: it is gone, so it publishes nothing and
    // a stored port must not resurrect it.
    return { known: true, hostPort: info.hostPort };
  } catch {
    return { known: false };
  }
}

/**
 * The ONE live upstream resolver — what every route-registration site outside a
 * deploy should call.
 *
 * Live container state decides the upstream: a routed workload with no loopback
 * publish (migrated, adopted in place, or an internal compose service) resolves
 * to its container IP instead of a port nothing listens on. `stored` — the
 * persisted `service_deployment` row — is consulted ONLY when the live read
 * could not be performed, so one failed inspect keeps the last-known route
 * instead of blanking a working vhost.
 */
export async function resolveLiveUpstreamUrl(args: {
  strategy: RouteStrategy;
  runtime: LiveUpstreamRuntime;
  containerId: string;
  containerPort: number;
  stored?: StoredUpstream;
}): Promise<string | null> {
  const { strategy, runtime, containerId, containerPort, stored } = args;
  const live = await readLiveHostPort(runtime, containerId, strategy);
  const hostPort = live.known ? live.hostPort : (stored?.hostPort ?? undefined);
  const url = await resolveUpstreamUrl({
    strategy,
    runtime,
    containerId,
    containerPort,
    hostPort,
  }).catch(() => null);
  return url ?? buildUpstreamUrl({ strategy, ip: stored?.ip, hostPort, containerPort });
}

/**
 * Resolve a stored/selected strategy setting to a concrete strategy. "auto" (and
 * any unknown/legacy value) → "loopback-port", the safe default for bare + docker
 * self-host. "container-ip" is honored only when explicitly chosen.
 */
export function resolveRouteStrategy(
  setting: string | null | undefined,
): RouteStrategy {
  return setting === "container-ip" ? "container-ip" : "loopback-port";
}
