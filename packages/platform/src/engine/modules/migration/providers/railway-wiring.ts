import type { ImportBinding, PlannedImportService } from "../platform-import-plan";

const privateHost = /\b[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.railway\.internal\b/gi;

/** Keep Railway's resolved values, replacing provider DNS with the native service
 * aliases inside the imported project. Dependencies describe deployment order;
 * they do not create cross-project connections or publish database ports. */
export function resolveRailwayBindings(
  service: PlannedImportService,
  selected: Map<string, PlannedImportService>,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const sources = [...selected.values()];
  for (const [key, value] of Object.entries(service.source.env)) {
    if (value.includes("${{"))
      service.source.blockers.push(`Review ${key}: Railway did not resolve this reference.`);
    const hosts = [...new Set(value.match(privateHost) ?? [])];
    if (!hosts.length) continue;
    const dependencies = hosts.map((host) => ({
      host,
      source: sources.find((s) => s.source.privateDomain?.toLowerCase() === host.toLowerCase()),
    }));
    if (dependencies.some((dependency) => !dependency.source)) {
      service.source.blockers.push(
        `Review ${key}: its Railway private host does not belong to this project.`,
      );
      continue;
    }
    let resolved = value;
    for (const { host, source } of dependencies) {
      resolved = resolved.replaceAll(host, source!.create.internalAlias!);
      if (source !== service) bindings.push({ sourceId: source!.source.id, envKey: key });
      // A resolved URL can declare an otherwise undiscovered private listener.
      // A hostname-only value still works through the project network's DNS.
      if (!source!.source.port) {
        try {
          const url = new URL(value);
          const port = Number(
            url.port || (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 0),
          );
          if (url.hostname === host && port > 0 && port <= 65535) source!.source.port = port;
        } catch {
          /* diagnostics-ignore: arbitrary strings and hostname-only variables do not declare a listener. */
        }
      }
    }
    service.source.env[key] = resolved;
  }
  return bindings;
}
