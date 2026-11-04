import { normalizeComposeRoutingFields, repos, type Project } from "@repo/db";
import { normalizeRedirect, assertRedirectTargets } from "./domain-redirect";
import {
  publicEndpointHostname,
  resolveServicePublicEndpoints,
  type ServiceRoutingPatch,
} from "./public-endpoints";

/** Validate the desired hostname set before any service configuration is written. */
export async function assertServiceRedirects(
  project: Pick<Project, "id" | "slug">,
  changes: Array<ServiceRoutingPatch & { id?: string; name: string; ports?: string[] | null }>,
): Promise<void> {
  // Do this before the read normalizer can coerce an invalid status.
  for (const service of changes) {
    for (const endpoint of service.publicEndpoints ?? []) normalizeRedirect(endpoint);
  }
  const [domains, stored] = await Promise.all([
    repos.domain.listByProject(project.id),
    repos.service.listByProject(project.id),
  ]);
  const names = new Set(changes.map((service) => service.name));
  const replacedIds = new Set(changes.flatMap((service) => (service.id ? [service.id] : [])));
  for (const service of stored) {
    if (names.has(service.name)) replacedIds.add(service.id);
  }
  const storedById = new Map(stored.map((service) => [service.id, service]));
  const storedByName = new Map(stored.map((service) => [service.name, service]));
  const hosts = new Map(
    domains
      .filter((domain) => !domain.serviceId || !replacedIds.has(domain.serviceId))
      .map((domain) => [
        domain.hostname,
        { hostname: domain.hostname, redirectTo: domain.redirectTo },
      ]),
  );
  const previous = new Map(domains.map((domain) => [domain.hostname, domain]));
  for (const service of changes) {
    const current = service.id ? storedById.get(service.id) : storedByName.get(service.name);
    // Compose sync retains omitted routing fields. Validate the same desired
    // configuration it will persist, including routes on paused services.
    const routing = normalizeComposeRoutingFields(service, current);
    for (const endpoint of resolveServicePublicEndpoints(
      { ...current, ...service, ...routing, exposed: true },
      { projectSlug: project.slug },
    )) {
      const hostname = publicEndpointHostname(endpoint);
      if (hostname)
        hosts.set(hostname, {
          hostname,
          redirectTo: endpoint.redirectTo ?? previous.get(hostname)?.redirectTo ?? null,
        });
    }
  }
  assertRedirectTargets([...hosts.values()]);
}
