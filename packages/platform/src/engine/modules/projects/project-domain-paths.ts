import { Value } from "@sinclair/typebox/value";
import { ProjectDomainPathsSchema } from "@repo/contracts";
import { ValidationError, type ProjectCompositeRoute } from "@repo/core";
import { repos, type Project, type Service } from "@repo/db";
import {
  isStaticService,
  parseServicePort,
  resolveServicePort,
} from "../../lib/deployable-service";
import { resolveServicePublicEndpoints } from "../../lib/public-endpoints";

function servicePort(service: Service, requested?: number | null): number {
  const declared = new Set<number>();
  for (const spec of [service.exposedPort, ...(service.ports ?? [])]) {
    const port = parseServicePort(spec);
    if (port != null) declared.add(port);
  }
  for (const endpoint of resolveServicePublicEndpoints(service)) {
    if (endpoint.port != null) declared.add(endpoint.port);
  }
  const port = requested ?? resolveServicePort(service);
  if (!port || !declared.has(port)) {
    throw new ValidationError(`Choose a declared container port for service "${service.name}".`);
  }
  return port;
}

/** Prepare all changes before writing; caller holds the project's runtime lock.
 * A hostname has one root owner and one complete path table. No duplicated domain
 * rows, service endpoint arrays or host/port URLs become a second routing source. */
export async function prepareProjectDomainPaths(
  project: Project,
  input: unknown,
): Promise<ProjectCompositeRoute[] | null> {
  if (!Value.Check(ProjectDomainPathsSchema, input)) {
    throw new ValidationError(
      "Invalid domain path routing. Choose a domain, literal path, project service and container port.",
    );
  }
  const [domains, services] = await Promise.all([
    repos.domain.listByProject(project.id),
    repos.service.listByProject(project.id),
  ]);
  const next = new Map(
    (project.compositeRoutes ?? []).map((route) => [route.hostname.toLowerCase(), route]),
  );
  const touched = new Set<string>();
  for (const patch of input) {
    const domain = domains.find((row) => row.id === patch.domainId && row.ownerType === "project");
    if (!domain || domain.status === "removing")
      throw new ValidationError("Choose a domain belonging to this project.");
    if (domain.redirectTo)
      throw new ValidationError("A redirecting domain cannot also forward service paths.");
    const hostname = domain.hostname.toLowerCase();
    if (touched.has(hostname))
      throw new ValidationError(`Duplicate domain routing change for ${hostname}.`);
    touched.add(hostname);
    if (!patch.paths.length) {
      // Path-only legacy imports have no base to restore: keep those explicit
      // tables until a root is configured rather than leaving an orphan vhost.
      if (
        next.has(hostname) &&
        !next.get(hostname)?.rootServiceId &&
        !domain.serviceId &&
        !domain.targetPort
      ) {
        throw new ValidationError(
          "This imported domain has no root service. Configure its root before clearing all paths.",
        );
      }
      next.delete(hostname);
      continue;
    }
    if ("boundByDomain" in domain && domain.boundByDomain && !domain.serviceId) {
      throw new ValidationError("Bind this domain to its root service before adding paths.");
    }
    const old = next.get(hostname);
    const rootId = domain.serviceId ?? old?.rootServiceId;
    const rootPort = domain.targetPort ?? old?.rootPort;
    const roots = services.filter(
      (service) =>
        service.projectId === project.id &&
        service.enabled &&
        (rootId
          ? service.id === rootId
          : rootPort != null && resolveServicePort(service) === rootPort),
    );
    if (roots.length !== 1 || isStaticService(roots[0]!)) {
      throw new ValidationError(
        "Choose a container-backed root service for this domain before adding paths.",
      );
    }
    const root = roots[0]!;
    if (domain.serviceId && !root.exposed) {
      throw new ValidationError("Expose this domain's root service before adding paths.");
    }
    const seen = new Set<string>();
    const locations = patch.paths.map((path) => {
      if (
        path.pathPrefix === "/" ||
        path.pathPrefix.includes("//") ||
        path.pathPrefix.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        throw new ValidationError(
          "Use a literal path such as /api, without traversal or encoded separators.",
        );
      }
      const key = `${path.pathPrefix}:${Boolean(path.exact)}`;
      if (seen.has(key)) throw new ValidationError(`Duplicate path ${path.pathPrefix}.`);
      seen.add(key);
      const service = services.find(
        (row) => row.id === path.serviceId && row.projectId === project.id && row.enabled,
      );
      if (!service || isStaticService(service))
        throw new ValidationError("Choose an enabled container service of this project.");
      return {
        pathPrefix: path.pathPrefix,
        serviceId: service.id,
        port: servicePort(service, path.port),
        ...(path.exact ? { exact: true } : {}),
      };
    });
    next.set(hostname, {
      hostname,
      isCustomDomain: domain.domainType !== "free",
      rootServiceId: root.id,
      rootPort: servicePort(root, rootPort),
      locations,
    });
  }
  return next.size ? [...next.values()] : null;
}
