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

type UpstreamRuntime = Pick<RuntimeAdapter, "name" | "supports" | "getContainerIp">;

/** Runtime surface needed to decide which network namespace an edge dials. */
type RouteTopologyRuntime = Pick<RuntimeAdapter, "name" | "supports">;

/**
 * Whether a self-hosted route can dial through the target host's loopback
 * namespace.
 *
 * `routeStrategy` is an operator preference, not proof that a bridge address is
 * available. Bare workloads always bind the host directly, and a runtime which
 * cannot expose a container IP must use a published host port even when the
 * stored preference is `container-ip`. Every pre-bind claim/lock decision uses
 * this predicate so the allocator and the eventual proxy target cannot disagree.
 */
export function usesHostLoopbackUpstream(
  strategy: RouteStrategy,
  runtime: RouteTopologyRuntime,
): boolean {
  return (
    runtime.name !== "cloud" &&
    (strategy === "loopback-port" || runtime.name === "bare" || !runtime.supports("containerIp"))
  );
}

/** Runtime surface needed to read a container's CURRENT publishing. */
type LiveUpstreamRuntime = UpstreamRuntime & {
  getContainerInfo?: RuntimeAdapter["getContainerInfo"];
};

/**
 * Last-known upstream for a container, as persisted on `service_deployment`.
 * A CACHE of a past live read — never authoritative on its own.
 */
export interface StoredUpstream {
  ip?: string | null;
  hostPort?: number | null;
  /** Durable CONTAINER-port → host-port bindings from `service_deployment`.
   * When at least one concrete entry exists, the map is authoritative: a missing
   * key means that container port is not published and must not borrow the scalar
   * (which may belong to a sibling port). */
  hostPorts?: Record<string, number> | null;
}

/** Resolve one stored publish without ever applying a sibling port's scalar.
 *
 * `__legacy__` is the migration marker used for old scalar-only rows. It is not a
 * per-container-port answer, so a map containing only that marker deliberately
 * falls back to `hostPort` for backwards compatibility. */
export function storedHostPortFor(
  stored: Pick<StoredUpstream, "hostPort" | "hostPorts"> | undefined,
  containerPort: number,
): number | undefined {
  const entries = Object.entries(stored?.hostPorts ?? {}).filter(([container, host]) => {
    const parsed = Number(container);
    return (
      Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed <= 65_535 &&
      Number.isInteger(host) &&
      host > 0
    );
  });
  if (entries.length === 0) return stored?.hostPort ?? undefined;

  const exact = entries.find(([container]) => Number(container) === containerPort)?.[1];
  if (exact !== undefined) return exact;

  // Some project-level routes are authored with the published side of a compose
  // mapping. If that exact number belongs to this container, dialing it is safe.
  if (entries.some(([, host]) => host === containerPort)) return containerPort;

  // A concrete map exists and this port is absent: it is not published. Returning
  // the scalar here is the cross-port misroute this map exists to prevent.
  return undefined;
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
 * already hold the ip + host-port bindings (routing-API sites reading persisted
 * `service_deployment.{ip,hostPort,hostPorts}`) use this directly; the runtime-aware
 * `resolveUpstreamUrl` resolves the ip first, then delegates here — so every
 * route-registration site funnels through ONE function, no fork.
 */
export function buildUpstreamUrl(args: {
  strategy: RouteStrategy;
  ip?: string | null;
  hostPort?: number | null;
  hostPorts?: Record<string, number> | null;
  containerPort: number;
}): string | null {
  const hostPort = storedHostPortFor(args, args.containerPort);
  if (args.strategy === "loopback-port" && hostPort) {
    return `http://127.0.0.1:${hostPort}`;
  }
  return args.ip ? `http://${args.ip}:${args.containerPort}` : null;
}

export async function resolveUpstreamUrl(args: ResolveUpstreamArgs): Promise<string | null> {
  const { strategy, runtime, containerId, containerPort, hostPort } = args;
  const usesHostLoopback = usesHostLoopbackUpstream(strategy, runtime);

  // Dial the reserved publish whenever this topology needs host loopback. That
  // includes a runtime without container-IP support even if the stored strategy
  // says `container-ip`; ignoring its hostPort would dial the unrelated
  // 127.0.0.1:<containerPort> instead. Bare has no separate publish and falls
  // through to its own 127.0.0.1:<appPort> identity below.
  if (usesHostLoopback && hostPort) {
    return `http://127.0.0.1:${hostPort}`;
  }
  const ip = runtime.supports("containerIp")
    ? await runtime.getContainerIp(containerId)
    : "127.0.0.1";
  return buildUpstreamUrl({
    strategy: usesHostLoopback ? "loopback-port" : "container-ip",
    ip,
    hostPort,
    containerPort,
  });
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
  containerPort: number,
  requireRunning: boolean,
): Promise<{ known: boolean; running?: boolean; hostPort?: number }> {
  const usesHostLoopback = usesHostLoopbackUpstream(strategy, runtime);
  // Bare owns `127.0.0.1:<appPort>` outright and has no separate publish to read.
  if (runtime.name === "bare") return { known: true, running: true };
  if (!usesHostLoopback && !requireRunning) return { known: true };
  if (!runtime.getContainerInfo || !runtime.supports("containerInfo")) return { known: false };
  try {
    const info = await runtime.getContainerInfo(containerId);
    const running = info.status === "running";
    if (requireRunning && !running) return { known: true, running: false };
    if (!usesHostLoopback) return { known: true, running };
    // A `missing` container answers too: it is gone, so it publishes nothing and
    // a stored port must not resurrect it.
    //
    // PER-PORT when the runtime can say. `info.hostPort` is whichever binding the
    // daemon listed first, so for a container publishing several ports it is the WRONG
    // number for all but one of them: a route for the second port was dialed at the
    // first port's publish and quietly served a different app.
    const byPort = info.hostPortByContainerPort;
    if (byPort) {
      const published = byPort[containerPort];
      if (published) return { known: true, running, hostPort: published };
      // `containerPort` is what the CALLER believes it is, and a project-level route
      // carries whichever side of the mapping the operator typed (project-route's
      // primary-container fallback passes it straight through). When the number is a
      // host port on this very container, `127.0.0.1:<it>` is exact — not a borrowed
      // sibling — and skipping to the container IP would dial a port nothing there
      // listens on. Keys win over values so a container mapping 3000→8080 alongside
      // 8080→34100 still resolves 8080 to its own publish.
      if (Object.values(byPort).includes(containerPort)) {
        return { known: true, running, hostPort: containerPort };
      }
      // Neither side matches: the port genuinely isn't published. "known, none" is
      // what makes the caller fall through to the container IP instead of borrowing a
      // sibling's port. NOT widened to "the map has one entry, so use it" — a map
      // lists only PUBLISHED ports, so a lone entry says nothing about whether the
      // container also listens on this one unexposed (minio publishing 9001 and not
      // 9000 is exactly that shape).
      return { known: true, running };
    }
    return { known: true, running, hostPort: info.hostPort };
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
  /**
   * Route writers set this so a failed inspect, missing/stopped container, or
   * stale imported cache can never mint a new vhost to a recycled address. The
   * default remains fail-soft for read-only callers that only need last-known
   * state.
   */
  requireLiveObservation?: boolean;
}): Promise<string | null> {
  const {
    strategy,
    runtime,
    containerId,
    containerPort,
    stored,
    requireLiveObservation = false,
  } = args;
  const usesHostLoopback = usesHostLoopbackUpstream(strategy, runtime);
  const live = await readLiveHostPort(
    runtime,
    containerId,
    strategy,
    containerPort,
    requireLiveObservation,
  );
  if (requireLiveObservation && (!live.known || live.running === false)) return null;
  const hostPort = live.known ? live.hostPort : storedHostPortFor(stored, containerPort);
  const url = await resolveUpstreamUrl({
    strategy,
    runtime,
    containerId,
    containerPort,
    hostPort,
  }).catch(() => null);
  if (url || requireLiveObservation) return url;
  return buildUpstreamUrl({
    strategy: usesHostLoopback ? "loopback-port" : "container-ip",
    ip: stored?.ip,
    hostPort,
    containerPort,
  });
}

/**
 * Resolve a stored/selected strategy setting to a concrete strategy. "auto" (and
 * any unknown/legacy value) → "loopback-port", the safe default for bare + docker
 * self-host. "container-ip" is honored only when explicitly chosen.
 */
export function resolveRouteStrategy(setting: string | null | undefined): RouteStrategy {
  return setting === "container-ip" ? "container-ip" : "loopback-port";
}
