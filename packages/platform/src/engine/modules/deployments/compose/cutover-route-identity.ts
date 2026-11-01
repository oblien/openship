import {
  parseServicePort,
  resolveServicePort,
} from "../../../lib/deployable-service";

/** Recovery reuses current route planners. Only overlap when every requested
 * upstream port belonged to this container's own frozen service configuration. */
export function hasRestorableServicePorts(
  snapshot: unknown,
  serviceName: string,
  requestedPorts: readonly number[],
): boolean {
  if (!snapshot || typeof snapshot !== "object" || !requestedPorts.length)
    return false;
  const frozen = snapshot as { port?: unknown; composeServices?: unknown };
  if (!Array.isArray(frozen.composeServices)) return false;
  const matches = frozen.composeServices.filter(
    (value): value is Record<string, unknown> =>
      !!value &&
      typeof value === "object" &&
      value.name === serviceName &&
      value.enabled !== false,
  );
  if (matches.length !== 1) return false;
  const service = matches[0]!;
  if (
    service.ports != null &&
    (!Array.isArray(service.ports) ||
      service.ports.some((port) => typeof port !== "string"))
  )
    return false;
  if (service.exposedPort != null && typeof service.exposedPort !== "string")
    return false;
  if (
    service.publicEndpoints != null &&
    !Array.isArray(service.publicEndpoints)
  )
    return false;
  const ports = service.ports as string[] | undefined;
  const known = new Set<number>();
  const add = (port: number | null) => {
    if (port != null && Number.isInteger(port) && port > 0 && port <= 65_535)
      known.add(port);
  };
  add(
    resolveServicePort(
      { exposedPort: service.exposedPort as string | undefined, ports },
      typeof frozen.port === "number" ? frozen.port : undefined,
    ),
  );
  for (const port of ports ?? []) add(parseServicePort(port));
  for (const endpoint of (service.publicEndpoints ?? []) as unknown[]) {
    if (!endpoint || typeof endpoint !== "object") return false;
    const port = (endpoint as { port?: unknown }).port;
    if (typeof port !== "number" && typeof port !== "string") return false;
    add(parseServicePort(String(port)));
  }
  return requestedPorts.every(
    (port) => Number.isInteger(port) && known.has(port),
  );
}
