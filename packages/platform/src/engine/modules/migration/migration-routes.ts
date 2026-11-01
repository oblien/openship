import { repos, type Service, type ServicePublicEndpoint } from "@repo/db";
import { ValidationError, type ProjectCompositeRoute } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { resolveServicePort } from "../../lib/deployable-service";
import { publicEndpointHostname } from "../../lib/public-endpoints";
import { ensureRouteDomainRecord } from "../../lib/routing-domains";
import {
  ensurePendingServiceDomain,
  resolveServiceDomainOwnership,
} from "../domains/domain.service";
import { updateService } from "../services/service.service";
import type { DiscoveredService } from "./docker-reconcile";
import type { MigrationRouteSpec, MigrationServiceRoutes } from "./migration-input";
import type { ExistingRoute } from "./proxy-route-scan";
import { perService, serviceUid } from "./select-services";

/** Container identity wins; legacy names and repo-only services remain supported. */
export function remapMigrationRoutes(
  routes: MigrationServiceRoutes | undefined,
  chosen: DiscoveredService[],
  renames: Record<string, string>,
): MigrationServiceRoutes | undefined {
  if (!routes) return undefined;
  const discoveredKeys = new Set(chosen.flatMap((service) => [serviceUid(service), service.name]));
  const remapped = Object.fromEntries(
    Object.entries(routes).filter(([key]) => !discoveredKeys.has(key)),
  );
  for (const service of chosen) {
    const selected = perService(routes, service);
    if (selected !== undefined) remapped[perService(renames, service) ?? service.name] = selected;
  }
  return remapped;
}

interface RouteEntry {
  service: Service;
  spec: MigrationRouteSpec;
  endpoint: ServicePublicEndpoint;
  hostname: string;
  path: string;
}

/** A real source catch-all needs a decision before replacing it with paths only. */
export function findOmittedMigrationRootRoutes(
  routes: MigrationServiceRoutes | undefined,
  sourceRoutes: Pick<ExistingRoute, "domains" | "path" | "exact">[],
): string[] {
  const pathsByHostname = new Map<string, boolean>();
  for (const selected of Object.values(routes ?? {})) {
    for (const spec of Array.isArray(selected) ? selected : [selected]) {
      const hostname = publicEndpointHostname({
        domainType: spec.domainType,
        customDomain: spec.customDomain,
        domain: spec.domain,
      });
      if (!hostname) continue;
      const root = (!spec.targetPath || spec.targetPath === "/") && !spec.exact;
      pathsByHostname.set(hostname, root || pathsByHostname.get(hostname) === true);
    }
  }
  return [...new Set(sourceRoutes.flatMap((route) =>
    route.path === "/" && !route.exact
      ? route.domains.map(hostname => hostname.trim().toLowerCase())
          .filter(hostname => pathsByHostname.get(hostname) === false)
      : [],
  ))];
}

/** Validate the whole selection before writing any part of it. */
export function planMigrationRoutes(services: Service[], routes: MigrationServiceRoutes) {
  const byName = new Map(services.map((service) => [service.name, service]));
  const byHostname = new Map<string, RouteEntry[]>();
  for (const [name, selected] of Object.entries(routes)) {
    const service = byName.get(name);
    if (!service)
      throw new ValidationError(`The route refers to an unknown migrated service: ${name}`);
    for (const spec of Array.isArray(selected) ? selected : [selected]) {
      const port = Number(spec.exposedPort ?? resolveServicePort(service));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ValidationError(
          `Choose the container port for ${name}'s route before migrating.`,
        );
      }
      const endpoint: ServicePublicEndpoint = {
        port,
        domainType: spec.domainType,
        ...(spec.domainType === "custom"
          ? { customDomain: spec.customDomain }
          : { domain: spec.domain }),
      };
      const hostname = publicEndpointHostname(endpoint);
      if (!hostname)
        throw new ValidationError(`Choose a hostname for ${name}'s route before migrating.`);
      const path = spec.targetPath || "/";
      const entries = byHostname.get(hostname) ?? [];
      const prior = entries.find(
        (entry) => entry.path === path && Boolean(entry.spec.exact) === Boolean(spec.exact),
      );
      if (prior) {
        if (prior.service.id !== service.id || prior.endpoint.port !== port) {
          throw new ValidationError(
            `${hostname}${path} is assigned to more than one service or port.`,
          );
        }
        continue;
      }
      entries.push({ service, spec, endpoint, hostname, path });
      byHostname.set(hostname, entries);
    }
  }

  const endpointsByService = new Map<string, ServicePublicEndpoint[]>();
  const domains: RouteEntry[] = [];
  const composites: ProjectCompositeRoute[] = [];
  for (const [hostname, entries] of byHostname) {
    const root = entries.find((entry) => entry.path === "/" && !entry.spec.exact);
    if (!root) {
      domains.push(entries[0]);
      composites.push({
        hostname,
        isCustomDomain: entries[0].spec.domainType === "custom",
        locations: entries.map((entry) => ({
          pathPrefix: entry.path,
          serviceId: entry.service.id,
          port: entry.endpoint.port,
          ...(entry.spec.exact ? { exact: true } : {}),
        })),
      });
      continue;
    }
    domains.push(root);
    const endpoints = endpointsByService.get(root.service.id) ?? [];
    const alias = endpoints.some((endpoint) => endpoint.port === root.endpoint.port);
    if (!alias) endpoints.push(root.endpoint);
    else if (root.spec.domainType === "free") {
      throw new ValidationError(
        `Only one managed hostname can use ${root.service.name}:${root.endpoint.port}. Use a custom domain for an alias.`,
      );
    }
    endpointsByService.set(root.service.id, endpoints);
    const locations = entries
      .filter((entry) => entry !== root)
      .map((entry) => ({
        pathPrefix: entry.path,
        serviceId: entry.service.id,
        port: entry.endpoint.port,
        ...(entry.spec.exact ? { exact: true } : {}),
      }));
    if (alias || locations.length > 0)
      composites.push({
        hostname,
        isCustomDomain: root.spec.domainType === "custom",
        rootServiceId: root.service.id,
        rootPort: root.endpoint.port,
        locations,
      });
  }
  return { endpointsByService, domains, composites };
}

/** Save the reviewed routes and ownership BEFORE edge setup or container changes. */
export async function saveMigrationRoutes(
  ctx: ExecutionContext,
  projectId: string,
  routes: MigrationServiceRoutes | undefined,
  log: (message: string) => void,
): Promise<string[]> {
  if (!routes || Object.keys(routes).length === 0) return [];
  const services = await repos.service.listByProject(projectId);
  const plan = planMigrationRoutes(services, routes);
  // Discover a taken/invalid hostname before changing ANY service in a reused
  // project. The write path repeats this shared gate and handles insert races.
  for (const root of plan.domains) {
    if (root.spec.domainType === "custom")
      await resolveServiceDomainOwnership({ projectId, hostname: root.hostname });
  }
  for (const [serviceId, endpoints] of plan.endpointsByService) {
    await updateService(
      ctx,
      projectId,
      serviceId,
      {
        exposed: true,
        publicEndpoints: endpoints,
      },
      { applyLiveRoutes: false },
    );
  }
  const domainByHostname = new Map(
    (await repos.domain.listByProject(projectId)).map((domain) => [domain.hostname.toLowerCase(), domain]),
  );
  for (const root of plan.domains) {
    if (root.path !== "/" || root.spec.exact) {
      // A path-only hostname belongs to the project topology. Giving a service
      // an endpoint here would also publish an unintended catch-all at `/`.
      await ensureRouteDomainRecord({
        projectId,
        domainByHostname,
        route: {
          hostname: root.hostname,
          domainType: root.spec.domainType,
          createIfMissing: true,
          tls: true,
          requiresSslTooling: false,
          provisionSsl: false,
          terminatesTlsLocally: root.spec.domainType === "custom",
          isCloud: root.spec.domainType === "free",
        },
      });
      const paths = plan.composites.find(route => route.hostname === root.hostname)!.locations
        .map(location => `${location.exact ? "exact " : ""}${location.pathPrefix}`);
      log(`saved path-only route ${root.hostname}: ${paths.join(", ")}; unmatched paths return 404`);
      continue;
    }
    if (root.spec.domainType === "custom")
      await ensurePendingServiceDomain({
        projectId,
        serviceId: root.service.id,
        hostname: root.hostname,
        targetPort: root.endpoint.port,
      });
    log(`saved route ${root.hostname} → ${root.service.name}:${root.endpoint.port}`);
  }
  const project = await repos.project.findById(projectId);
  const replaced = new Set(plan.domains.map((root) => root.hostname));
  await repos.project.update(projectId, {
    compositeRoutes: [
      ...(project?.compositeRoutes ?? []).filter((route) => !replaced.has(route.hostname)),
      ...plan.composites,
    ],
  });
  return [...replaced];
}
