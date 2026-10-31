import { repos, type Project } from "@repo/db";
import { normalizeRedirect, assertRedirectTargets } from "./domain-redirect";
import {
  publicEndpointHostname,
  resolveServicePublicEndpoints,
  type ServiceRoutingPatch,
} from "./public-endpoints";

/** Validate the desired hostname set before any service configuration is written. */
export async function assertServiceRedirects(
  project: Pick<Project, "id" | "slug">,
  changes: Array<ServiceRoutingPatch & { name: string; ports?: string[] | null }>,
): Promise<void> {
  if (!changes.some((service) => service.publicEndpoints?.some((endpoint) => endpoint.redirectTo)))
    return;
  // Do this before the read normalizer can coerce an invalid status.
  for (const service of changes) {
    for (const endpoint of service.publicEndpoints ?? []) normalizeRedirect(endpoint);
  }
  const [domains, stored] = await Promise.all([
    repos.domain.listByProject(project.id),
    repos.service.listByProject(project.id),
  ]);
  const names = new Set(changes.map((service) => service.name));
  const replacedIds = new Set(
    stored.filter((service) => names.has(service.name)).map((service) => service.id),
  );
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
    for (const endpoint of resolveServicePublicEndpoints(
      { ...service, exposed: true },
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
