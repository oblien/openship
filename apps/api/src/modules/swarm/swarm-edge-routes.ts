/** Reconcile project domain records to scheduler-safe OpenShip Edge vhosts. */

import {
  SwarmEdgeRouteManager,
  type CommandExecutor,
  type SwarmEdgeCertificateStatus,
  type SwarmEdgeRouteInput,
} from "@repo/adapters";
import type { Domain, Project, Service, SwarmStack } from "@repo/db";
import { buildServiceRouteDomains } from "../../lib/routing-domains";
import { swarmEdgeServiceDnsName } from "./swarm-edge-routing";

export interface PlannedSwarmEdgeRoute {
  input: SwarmEdgeRouteInput;
  serviceId: string;
  domainType: "free" | "custom";
  domainId: string | null;
  /** A known Edge certificate can be mounted into the HTTPS vhost. */
  tls: boolean;
  /** HTTP-01 itself proves ownership for a direct custom domain. */
  provisionTls: boolean;
}

export interface SwarmEdgeRoutePlan {
  desired: PlannedSwarmEdgeRoute[];
  retiredDomains: string[];
  warnings: string[];
}

export interface SwarmEdgeRouteReconcileResult {
  warnings: string[];
  issued: Array<{ domainId: string; certificate: SwarmEdgeCertificateStatus }>;
}

function isCurrentSwarmService(service: Service): boolean {
  return service.kind === "swarm" && !!service.sourceServiceName && service.swarmProjection?.sourceState !== "removed";
}

/**
 * Builds a route plan from the existing domain/service source of truth. Nothing
 * here reads task IPs: every target remains a validated stack_service DNS name.
 */
export function planSwarmEdgeRoutes(input: {
  project: Project;
  stack: Pick<SwarmStack, "routingMode" | "stackName">;
  services: Service[];
  domains: Domain[];
}): SwarmEdgeRoutePlan {
  if (input.stack.routingMode !== "openship-edge") {
    return { desired: [], retiredDomains: [], warnings: [] };
  }
  const domains = new Map(input.domains.map((domain) => [domain.hostname.toLowerCase(), domain]));
  const desiredByDomain = new Map<string, PlannedSwarmEdgeRoute>();
  const warnings: string[] = [];

  for (const service of input.services.filter(isCurrentSwarmService)) {
    const sourceServiceName = service.sourceServiceName!;
    const serviceDnsName = swarmEdgeServiceDnsName(input.stack.stackName, sourceServiceName);
    const routes = buildServiceRouteDomains({
      project: input.project,
      service,
      runtimeName: "docker",
      usesManagedRouting: true,
      domainByHostname: domains,
    });
    for (const route of routes) {
      if (route.targetPort === undefined) continue;
      const domain = domains.get(route.hostname.toLowerCase());
      if (domain?.manualSsl) {
        warnings.push(
          `${route.hostname} uses a manually uploaded certificate, which cannot yet be mounted into the Swarm Edge. The HTTP route remains available.`,
        );
      }
      const candidate: PlannedSwarmEdgeRoute = {
        input: { domain: route.hostname, serviceDnsName, port: route.targetPort },
        serviceId: service.id,
        domainType: route.domainType ?? "custom",
        domainId: domain?.id ?? null,
        // A certificate marked active was issued into the same persistent Edge
        // volume. Manual certificates intentionally stay HTTP until their
        // dedicated Swarm-volume upload flow exists.
        tls: domain?.sslStatus === "active" && !domain.manualSsl && !domain.externalIngress,
        provisionTls:
          route.domainType === "custom" &&
          !domain?.externalIngress &&
          !domain?.manualSsl &&
          !!domain &&
          (domain.verified || domain.sslStatus === "none"),
      };
      const prior = desiredByDomain.get(route.hostname.toLowerCase());
      if (
        prior &&
        (prior.input.serviceDnsName !== candidate.input.serviceDnsName || prior.input.port !== candidate.input.port)
      ) {
        warnings.push(`${route.hostname} is configured by more than one Swarm service; the duplicate route was skipped.`);
        continue;
      }
      desiredByDomain.set(route.hostname.toLowerCase(), candidate);
    }
  }

  // Projection sync retains removed rows so their operator-managed routing can
  // be torn down on a source rename/removal without guessing from task history.
  const retiredDomains = input.services
    .filter((service) => service.kind === "swarm" && service.swarmProjection?.sourceState === "removed")
    .flatMap((service) =>
      buildServiceRouteDomains({
        project: input.project,
        service,
        runtimeName: "docker",
        usesManagedRouting: true,
        domainByHostname: domains,
      }).map((route) => route.hostname.toLowerCase()),
    )
    .filter((domain, index, values) => values.indexOf(domain) === index && !desiredByDomain.has(domain));

  return {
    desired: [...desiredByDomain.values()].sort((left, right) => left.input.domain.localeCompare(right.input.domain)),
    retiredDomains: retiredDomains.sort(),
    warnings,
  };
}

/**
 * Route errors are deliberately contained: a converged Swarm service remains
 * healthy if a vhost update or ACME order fails, and the caller persists an
 * action-required deployment warning for retry.
 */
export async function reconcileSwarmEdgeRoutes(input: {
  executor: Pick<CommandExecutor, "exec" | "writeFile" | "rm">;
  plan: SwarmEdgeRoutePlan;
}): Promise<SwarmEdgeRouteReconcileResult> {
  const manager = new SwarmEdgeRouteManager(input.executor);
  const warnings = [...input.plan.warnings];
  const issued: SwarmEdgeRouteReconcileResult["issued"] = [];
  for (const route of input.plan.desired) {
    try {
      await manager.register(route.input, { tls: route.tls });
      if (route.provisionTls && !route.tls) {
        const certificate = await manager.provisionTls(route.input);
        if (route.domainId) issued.push({ domainId: route.domainId, certificate });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown Edge route error";
      warnings.push(`${route.input.domain}: ${detail}`);
    }
  }
  for (const domain of input.plan.retiredDomains) {
    try {
      await manager.remove(domain);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown Edge route removal error";
      warnings.push(`${domain}: ${detail}`);
    }
  }
  return { warnings, issued };
}
