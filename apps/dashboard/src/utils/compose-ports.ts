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

/** One concrete TCP port suitable for a web-domain publish hint from `expose`. */
export function firstExposedTcpPort(ports: readonly string[]): string | undefined {
  for (const spec of ports) {
    const match = spec.trim().match(/^(\d+)(?:-(\d+))?(?:\/tcp)?$/i);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start >= 1 && end >= start && end <= 65535) return String(start);
  }
  return undefined;
}
