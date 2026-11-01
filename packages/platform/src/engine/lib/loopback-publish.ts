/**
 * Rewrite a compose service's docker port specs so an EDGE-ROUTED container port
 * is published on the loopback interface with a pinned host port
 * (`127.0.0.1:<hostPort>:<containerPort>`) — the compose-side of the loopback
 * route strategy, mirroring what single-app does. Port-only TCP specs get the
 * same treatment (see `portOnlyTcpContainerPorts`); every other spec the user
 * declared is left untouched.
 *
 * Pure + string-based (docker port syntax), so it's unit-testable without a
 * daemon. Handles the 1-part ("3000"), 2-part ("8080:3000"), 3-part
 * ("127.0.0.1:8080:80") forms and a "/udp"/"/sctp" proto suffix.
 */

/** The CONTAINER (private) port a docker port spec targets, or null if unparseable. */
export function specContainerPort(spec: string): number | null {
  const noProto = spec.split("/")[0]!.trim();
  const parts = noProto.split(":");
  const containerPart = parts[parts.length - 1]!;
  const n = Number(containerPart);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * TCP container ports published with a port-only spec ("4011", "4011/tcp"): no
 * host port and no interface. Docker picks their host port from the kernel's
 * ephemeral range, a new one on every start, where outbound connections can take
 * it before a restart. A container port that also has an explicit binding or a
 * UDP/SCTP spec is left to its specs: republishing it would drop those.
 */
export function portOnlyTcpContainerPorts(portSpecs: readonly string[]): number[] {
  const portOnly = new Set<number>();
  const keepAsDeclared = new Set<number>();
  for (const spec of portSpecs) {
    const containerPort = specContainerPort(spec);
    if (containerPort === null) continue;
    const [mapping, proto = "tcp"] = spec.trim().split("/");
    if (mapping!.includes(":") || proto.toLowerCase() !== "tcp") {
      keepAsDeclared.add(containerPort);
    } else {
      portOnly.add(containerPort);
    }
  }
  return [...portOnly].filter((port) => !keepAsDeclared.has(port));
}

/**
 * Return the port specs with `containerPort` republished on
 * `127.0.0.1:<hostPort>:<containerPort>` (replacing any existing binding for
 * that container port), all other specs preserved. Adds the binding if the
 * service didn't publish that port at all (edge-only/internal service).
 */
export function withLoopbackPublish(
  portSpecs: readonly string[],
  containerPort: number,
  hostPort: number,
): string[] {
  const kept = portSpecs.filter((spec) => specContainerPort(spec) !== containerPort);
  return [...kept, `127.0.0.1:${hostPort}:${containerPort}`];
}

/**
 * Republish EVERY routed container port on its own pinned loopback host port.
 *
 * A service can own several routes (minio's console + `s3` API), and each needs a
 * DISTINCT host port or the edge cannot tell them apart.
 */
export function withLoopbackPublishAll(
  portSpecs: readonly string[],
  /** routed container port → the loopback host port pinned for it. */
  pinned: ReadonlyMap<number, number>,
): string[] {
  let out = [...portSpecs];
  for (const [containerPort, hostPort] of pinned) {
    out = withLoopbackPublish(out, containerPort, hostPort);
  }
  return out;
}

/**
 * The host port a route's upstream should dial for `port`.
 *
 * The pinned map is authoritative. `resultHostPort` — a single scalar read back
 * off the daemon — is only meaningful for the PRIMARY routed port: applying it to
 * a secondary port is what made every extra subdomain proxy to the first route's
 * port (minio's `s3` host served the console). Undefined means "no host port",
 * which sends the caller to container-IP addressing instead of a wrong guess.
 */
export function upstreamHostPortFor(args: {
  port: number;
  pinned: ReadonlyMap<number, number>;
  primaryPort?: number;
  resultHostPort?: number | null;
  sameService: boolean;
}): number | undefined {
  const { port, pinned, primaryPort, resultHostPort, sameService } = args;
  return (
    pinned.get(port) ??
    (sameService && port === primaryPort && resultHostPort ? resultHostPort : undefined)
  );
}
