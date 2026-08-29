/**
 * Which SERVICE a project-level route's port belongs to — and the upstream URL
 * that route dials.
 *
 * `deployment.container_id` answers "which container does a project-level question
 * mean". For a single-app release that is exact. For an ADOPTED (in-place migrated)
 * release there is no answer at all: both re-attach paths store the COMPOSE_SENTINEL
 * instead of a container id (migrate.service.ts → `reattachRuntime` /
 * `attachLiveRuntime`). The live route re-apply read that sentinel as "there is no
 * upstream to point a project-level route at" and registered nothing, so a migrated
 * project's domain row had no writer on any path — it verified, got a certificate,
 * and never got a vhost (#618).
 *
 * The route's PORT decides instead. That is the question the operator answers in the
 * Domains tab ("Mapped to → port 3000"), and it is the same question the tab's own
 * `findServiceByPort` asks when it attaches a route to a service — matching EITHER
 * side of a compose mapping, so this does too.
 *
 * It deliberately does NOT guess. A port no service declares returns null, and the
 * caller then falls back to the release's own primary container or skips the route:
 * answering "the primary service" for an unmatched port would proxy a public domain
 * at whatever the service list happens to start with, which on an adopted stack is
 * the DATABASE — the exact failure the sentinel guard was added to stop.
 *
 * PURE except for the one runtime read `resolveLiveUpstreamUrl` performs, so the
 * picking rule is unit-testable without a database.
 */

import { parseServiceHostPort, parseServicePort, resolveServicePort } from "./deployable-service";
import { pickPrimaryServiceId } from "./public-endpoints";
import { buildUpstreamUrl, resolveLiveUpstreamUrl, type RouteStrategy } from "./upstream-url";

/** The service-definition fields the port match reads. */
export interface UpstreamCandidateService {
  id: string;
  name: string;
  enabled?: boolean | null;
  exposed?: boolean | null;
  exposedPort?: string | null;
  ports?: string[] | null;
}

/** The `service_deployment` fields the upstream resolution reads. */
export interface UpstreamCandidateRow {
  serviceId: string;
  containerId?: string | null;
  ip?: string | null;
  /** Legacy/primary host-port scalar. Arbitrary for a multi-port container. */
  hostPort?: number | null;
  /** Durable CONTAINER-port → host-port bindings persisted on a service deployment. */
  hostPorts?: Record<string, number> | null;
  /** CONTAINER port → host port, when the caller knows the full picture (a deploy
   *  holds the runtime's report unioned with the pins it just published). */
  hostPortByContainerPort?: Record<number, number>;
}

/** Concrete per-port bindings, preferring the just-observed deploy result over its
 * persisted cache. Legacy migration markers are intentionally ignored. */
function rowHostPortEntries(
  row: UpstreamCandidateRow | undefined,
): Array<{ container: number; host: number }> {
  const bindings = row?.hostPortByContainerPort ?? row?.hostPorts;
  return Object.entries(bindings ?? {}).flatMap(([container, host]) => {
    const parsed = Number(container);
    return Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed <= 65_535 &&
      Number.isInteger(host) &&
      host > 0
      ? [{ container: parsed, host }]
      : [];
  });
}

/** Domain-row fields `pickPrimaryServiceId` breaks a tie on. */
export interface UpstreamCandidateDomain {
  verified: boolean;
  isPrimary: boolean;
  serviceId: string | null;
}

export interface ProjectPortOwner {
  serviceId: string;
  serviceName: string;
  /** The port to dial INSIDE the container — the container side of the matched
   *  mapping, which is NOT the route's port when the route named a published one. */
  containerPort: number;
  /** Which side of the mapping the route's port turned out to be. Carried for the log
   *  line, since "which service is this domain actually pointed at" is the thing that
   *  was impossible to see from outside. */
  via: "container-port" | "published-port";
}

export interface PortMatchInput {
  port: number;
  services: UpstreamCandidateService[];
  rowByService: Map<string, UpstreamCandidateRow>;
  /** ALL of the project's domain rows (service-scoped included). The canonical row is
   *  the first tie-breaker, so an ambiguous port resolves to the same service the
   *  project's access URL names — and to the same container `deployment.containerId`
   *  held, which is `pickPrimaryServiceId` over exactly this input. */
  domainRows?: UpstreamCandidateDomain[] | null;
}

/** Every port this service declares on the CONTAINER side. */
function containerPorts(service: UpstreamCandidateService): number[] {
  const ports = [
    parseServicePort(service.exposedPort),
    ...(service.ports ?? []).map((entry) => parseServicePort(entry)),
  ];
  return ports.filter((port): port is number => port !== null);
}

/**
 * Every port this service is PUBLISHED on, paired with the container port behind it —
 * as declared, plus the publish the live row last observed.
 *
 * The pairing is the point. A service mapping `["8080:3000", "9090:4000"]` matched on
 * 9090 must dial 4000; reading "the service's port" would answer 3000 and route the
 * domain at the wrong app.
 *
 * A legacy row's scalar publish has no declared mapping to pair with — adoption
 * strips declared publishes — so its container side can still be `null`. New rows
 * persist the complete map and therefore retain the exact pairing.
 */
function publishedPortPairs(
  service: UpstreamCandidateService,
  row: UpstreamCandidateRow | undefined,
): Array<{ published: number; container: number | null }> {
  const pairs: Array<{ published: number; container: number | null }> = [];
  const add = (published: number | null, container: number | null) => {
    if (published !== null) pairs.push({ published, container });
  };
  add(parseServiceHostPort(service.exposedPort), parseServicePort(service.exposedPort));
  for (const entry of service.ports ?? []) {
    add(parseServiceHostPort(entry), parseServicePort(entry));
  }
  const observed = rowHostPortEntries(row);
  if (observed.length > 0) {
    for (const binding of observed) add(binding.host, binding.container);
  } else if (row?.hostPort != null) {
    add(row.hostPort, resolveServicePort(service, null));
  }
  return pairs;
}

/** Services that could serve this route at all: enabled, with a live container. */
function upstreamCandidates(input: PortMatchInput): UpstreamCandidateService[] {
  // A disabled service is not a candidate even if a stale row still names its
  // container, and a container-less one has nothing to proxy to.
  return input.services.filter(
    (service) => service.enabled !== false && !!input.rowByService.get(service.id)?.containerId,
  );
}

/**
 * The service a project-level route on `port` belongs to, or null when no candidate
 * declares that port.
 *
 * A service matches on EITHER side of a mapping — the container port the app listens
 * on, or a host port it is published on — because both are numbers the operator sees
 * (the compose file, `docker ps`, the migration scan) and the Domains tab accepts
 * either. Ties are broken by `pickPrimaryServiceId`: the project's canonical domain
 * row first, then an `exposed` service, then list order. That is the same rule the
 * compose deploy used to pick `deployment.containerId`, so a route that resolved
 * through the primary container keeps landing on the same service.
 *
 * The DIAL port is read from the chosen service: the route's own port when the service
 * declares it container-side, else the container side paired with it as a publish.
 */
export function pickProjectPortOwner(input: PortMatchInput): ProjectPortOwner | null {
  const { port, rowByService, domainRows } = input;
  const candidates = upstreamCandidates(input);
  if (candidates.length === 0) return null;

  const matched = candidates.filter(
    (service) =>
      containerPorts(service).includes(port) ||
      publishedPortPairs(service, rowByService.get(service.id)).some(
        (pair) => pair.published === port,
      ),
  );
  if (matched.length === 0) return null;

  const chosenId = pickPrimaryServiceId(matched, domainRows);
  const chosen = matched.find((service) => service.id === chosenId) ?? matched[0];

  // Container-side first WITHIN the chosen service: a port it listens on is dialed
  // directly, and only a port it merely publishes needs its mapping followed.
  if (containerPorts(chosen).includes(port)) {
    return {
      serviceId: chosen.id,
      serviceName: chosen.name,
      containerPort: port,
      via: "container-port",
    };
  }
  const pair = publishedPortPairs(chosen, rowByService.get(chosen.id)).find(
    (candidate) => candidate.published === port,
  );
  return {
    serviceId: chosen.id,
    serviceName: chosen.name,
    // A live publish with no declared mapping behind it leaves the container side
    // unknown; the route's own port is then the only number available. Harmless under
    // loopback-port (which dials the publish, not this) — see publishedPortPairs.
    containerPort: pair?.container ?? port,
    via: "published-port",
  };
}

/**
 * The ports the release's candidate services actually offer, for the log line when a
 * route matches none of them. "no service declares port 8443" is only actionable next
 * to "web offers 3000, postgres offers 5432" — the operator's fix is to correct the
 * Mapped-to value, and this is what tells them to what.
 */
export function describeCandidatePorts(input: Omit<PortMatchInput, "port">): string {
  const described = upstreamCandidates({ ...input, port: 0 }).map((service) => {
    const declared = new Set<number>([
      ...containerPorts(service),
      ...publishedPortPairs(service, input.rowByService.get(service.id)).map((p) => p.published),
    ]);
    const ports = [...declared].sort((a, b) => a - b);
    return `${service.name}=${ports.length > 0 ? ports.join("/") : "none"}`;
  });
  return described.length > 0 ? described.join(", ") : "no service with a container";
}

/**
 * The upstream URL a project-level route on `port` dials, built from ip/hostPort the
 * caller ALREADY holds — for a DEPLOY, which just created the containers and recorded
 * their publishing, so asking the daemon again would be a round trip that can only
 * disagree with what it is about to persist.
 *
 * The pure half of the pair, mirroring `buildUpstreamUrl` vs `resolveLiveUpstreamUrl`
 * in upstream-url.ts: both halves share `pickProjectPortOwner`, so "which service owns
 * this port" has one answer while each caller supplies the facts it is entitled to.
 */
export function buildProjectServiceUpstream(
  input: PortMatchInput & { strategy: RouteStrategy },
): { url: string; owner: ProjectPortOwner } | null {
  const owner = pickProjectPortOwner(input);
  if (!owner) return null;
  const row = input.rowByService.get(owner.serviceId);
  if (!row?.containerId) return null;

  /**
   * Which host port belongs to the port we resolved.
   *
   * The legacy scalar `hostPort` is the pin of the service's PRIMARY routed port.
   * Applying it to another container port is not a near miss: it dials a DIFFERENT app
   * on the same box.
   *
   * A per-port map answers it exactly, and its ABSENCE of an entry is meaningful — that
   * port simply isn't published, so the upstream is the container IP rather than a
   * sibling's port. Without a map the scalar is trusted only where it is unambiguous: a
   * service declaring at most one container port can only have pinned that one.
   * (Declared host sides are no help: the deploy rewrites publishes to its own pins, so
   * `8080:3000` says nothing about what 3000 is actually bound to.)
   */
  const chosen = input.services.find((service) => service.id === owner.serviceId);
  const declaredContainerPorts = new Set(
    [
      parseServicePort(chosen?.exposedPort),
      ...(chosen?.ports ?? []).map((entry) => parseServicePort(entry)),
    ].filter((port): port is number => port !== null),
  );
  const hostPortEntries = rowHostPortEntries(row);
  const hostPort =
    hostPortEntries.length > 0
      ? hostPortEntries.find((binding) => binding.container === owner.containerPort)?.host
      : declaredContainerPorts.size <= 1
        ? row.hostPort
        : undefined;

  const url = buildUpstreamUrl({
    strategy: input.strategy,
    ip: row.ip,
    hostPort,
    containerPort: owner.containerPort,
  });
  return url ? { url, owner } : null;
}

/**
 * The upstream URL a project-level route on `port` dials, resolved through the ONE
 * live resolver (`resolveLiveUpstreamUrl`) so a multi-service project's project-level
 * route and its per-service routes can never disagree about how an upstream is built.
 *
 * Returns null when no service declares the port or the owner's upstream can't be
 * resolved — the caller then falls back or skips the route rather than writing a vhost
 * with a `proxy_pass` at something it guessed.
 *
 * Under `loopback-port` the shared resolver reads the publish belonging to THIS
 * container port (`ContainerInfo.hostPortByContainerPort`), so a multi-port container's
 * second route no longer dials the first port's publish. A port the container does not
 * publish resolves to its container IP rather than a sibling's number; the caller logs
 * the resolved URL so a mis-typed Mapped-to value is visible rather than silent.
 */
export async function resolveProjectServiceUpstream(
  input: PortMatchInput & {
    strategy: RouteStrategy;
    runtime: Parameters<typeof resolveLiveUpstreamUrl>[0]["runtime"];
    requireLiveObservation?: boolean;
  },
): Promise<{ url: string; owner: ProjectPortOwner } | null> {
  const owner = pickProjectPortOwner(input);
  if (!owner) return null;
  const row = input.rowByService.get(owner.serviceId);
  if (!row?.containerId) return null;

  const url = await resolveLiveUpstreamUrl({
    strategy: input.strategy,
    runtime: input.runtime,
    containerId: row.containerId,
    containerPort: owner.containerPort,
    // The persisted row is a CACHE of a past live read — `resolveLiveUpstreamUrl`
    // consults it only when it can't ask the daemon itself.
    stored: { ip: row.ip, hostPort: row.hostPort, hostPorts: row.hostPorts },
    requireLiveObservation: input.requireLiveObservation,
  });
  return url ? { url, owner } : null;
}
