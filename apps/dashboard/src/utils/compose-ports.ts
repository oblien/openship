/**
 * Container port from a single compose `ports` spec: the last colon-segment with
 * any `/proto` suffix stripped ("8203:80" → "80", "5432/tcp" → "5432", "80" → "80").
 * Undefined only for an empty string.
 */
export function parseContainerPort(spec: string): string | undefined {
  return spec.split(":").pop()?.split("/")[0];
}

/** Container port of a service's first published port, or undefined if it has none. */
export function serviceExposedPort(svc: { ports: string[] }): string | undefined {
  const first = svc.ports[0];
  return first ? parseContainerPort(first) : undefined;
}
