import type { ImportBinding, PlannedImportService } from "../platform-import-plan";

const privateHost = /\b[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.railway\.internal\b/gi;

/** Railway already resolves shared/reference variables. Keep those values,
 * replacing only provider-private hosts with ordinary service connections.
 * There is no database-name, URL-variable-name or engine registry here. */
export function resolveRailwayBindings(
  service: PlannedImportService,
  selected: Map<string, PlannedImportService>,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const sources = [...selected.values()];
  for (const [key, value] of Object.entries(service.source.env)) {
    if (value.includes("${{"))
      service.source.blockers.push(`Review ${key}: Railway did not resolve this reference.`);
  }
  for (const [key, value] of Object.entries(service.source.env)) {
    const hosts = [...new Set(value.match(privateHost) ?? [])];
    if (!hosts.length) continue;
    const dependencies = hosts.map((host) => ({
      host,
      source: sources.find((s) => s.source.privateDomain?.toLowerCase() === host.toLowerCase()),
    }));
    if (dependencies.some((d) => !d.source)) {
      service.source.blockers.push(
        `Review ${key}: its Railway private host does not belong to this project.`,
      );
      continue;
    }
    let template = value;
    for (const dependency of dependencies.filter((d) => d.source === service)) {
      template = template.replaceAll(dependency.host, service.create.internalAlias!);
    }
    const remote = dependencies.filter((d) => d.source !== service);
    if (remote.length > 1 || value.includes("${host}")) {
      service.source.blockers.push(
        `Review ${key}: it combines multiple private service addresses. Split these into separate connection variables before importing.`,
      );
      continue;
    }
    if (!remote.length) {
      service.source.env[key] = template;
      continue;
    }
    const dependency = remote[0].source!;
    // A private URL can supply a previously undeclared listener port. This is
    // protocol independent and does not publish that listener to the Internet.
    if (!dependency.source.port) {
      try {
        const url = new URL(value);
        const port = Number(
          url.port || (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 0),
        );
        if (url.hostname === remote[0].host && port > 0 && port <= 65535)
          dependency.source.port = port;
      } catch {
        /* diagnostics-ignore: a hostname-only value is valid; it simply cannot infer a port. */
      }
    }
    if (!dependency.source.port) {
      service.source.blockers.push(
        `Set a PORT for ${dependency.source.name} so ${key} can use its private connection.`,
      );
      continue;
    }
    bindings.push({
      sourceId: dependency.source.id,
      envKey: key,
      valueTemplate: template.replaceAll(remote[0].host, "${host}"),
    });
    delete service.source.env[key];
  }
  return bindings;
}
