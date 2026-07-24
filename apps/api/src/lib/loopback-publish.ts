/**
 * Rewrite a compose service's docker port specs so an EDGE-ROUTED container port
 * is published on the loopback interface with a pinned host port
 * (`127.0.0.1:<hostPort>:<containerPort>`) — the compose-side of the loopback
 * route strategy, mirroring what single-app does. Every OTHER spec (port-only
 * bindings the user declared for direct access) is left untouched, so we only
 * de-expose the ports the edge fronts.
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
