/** Fixed-route SSL adapter for custom domains served by OpenShip Swarm Edge. */

import {
  SwarmEdgeRouteManager,
  type SslProvider,
  type SslResult,
  type SwarmEdgeCertificateStatus,
  type SwarmEdgeRouteInput,
} from "@repo/adapters";
import type { Domain, Project, Service, SwarmStack } from "@repo/db";
import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { resolveServicePublicEndpoints } from "../../lib/public-endpoints";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import { swarmEdgeServiceDnsName } from "./swarm-edge-routing";

type EdgeRouteOperations = Pick<
  SwarmEdgeRouteManager,
  "register" | "provisionTls" | "certificateStatus"
>;

function sslResult(status: SwarmEdgeCertificateStatus, reason: "issued" | "renewed" | "missing"): SslResult {
  return {
    domain: status.domain,
    expiresAt: status.expiresAt,
    issuer: "letsencrypt",
    verified: status.verified,
    reason: status.verified ? reason : "missing",
  };
}

/**
 * An SslProvider deliberately bound to one domain and one service DNS target.
 * The generic domain workflow can use it without gaining an arbitrary proxy
 * target capability.
 */
export function createSwarmEdgeSslProvider(
  route: SwarmEdgeRouteInput,
  edge: EdgeRouteOperations,
): SslProvider {
  const assertDomain = (domain: string) => {
    if (domain.trim().toLowerCase() !== route.domain.trim().toLowerCase()) {
      throw new AppError("This SSL provider is bound to a different OpenShip Edge domain.", 409, "SWARM_EDGE_DOMAIN_MISMATCH");
    }
  };
  const issue = async (reason: "issued" | "renewed"): Promise<SslResult> => {
    // The HTTP vhost must precede certbot so the webroot challenge has a safe
    // host-specific response even when a deploy has not just reconciled routes.
    await edge.register(route, { tls: false });
    const certificate = await edge.provisionTls(route);
    return sslResult(certificate, reason);
  };
  return {
    async provisionCert(domain) {
      assertDomain(domain);
      return issue("issued");
    },
    async renewCert(domain) {
      assertDomain(domain);
      return issue("renewed");
    },
    async verifyCert(domain) {
      assertDomain(domain);
      return sslResult(await edge.certificateStatus(route.domain), "missing");
    },
    async installCert() {
      throw new AppError(
        "Manual certificate upload for OpenShip Swarm Edge is not available yet. Use a direct ACME certificate or external ingress.",
        409,
        "SWARM_EDGE_MANUAL_CERT_UNSUPPORTED",
      );
    },
  };
}

interface ResolveDependencies {
  getStack: (projectId: string, organizationId: string) => ReturnType<typeof repos.swarmStack.getForProjectInOrganization>;
  getService: (serviceId: string) => ReturnType<typeof repos.service.findById>;
  resolvePlatform: (serverId: string, organizationId: string) => ReturnType<typeof resolveTargetPlatform>;
  createManager: (platform: Awaited<ReturnType<typeof resolveTargetPlatform>>) => SwarmEdgeRouteManager;
}

/** Resolve a domain row to its exact exposed service and cluster Edge manager. */
export async function resolveSwarmEdgeSslProvider(
  project: Project,
  domain: Domain,
  overrides: Partial<ResolveDependencies> = {},
): Promise<SslProvider> {
  const deps: ResolveDependencies = {
    getStack: (projectId, organizationId) => repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    getService: (serviceId) => repos.service.findById(serviceId),
    resolvePlatform: (serverId, organizationId) => resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    createManager: (platform) => {
      if (!platform.executor) {
        throw new AppError("OpenShip Edge needs a manager command transport for TLS.", 503, "SWARM_EDGE_UNAVAILABLE");
      }
      return new SwarmEdgeRouteManager(platform.executor);
    },
    ...overrides,
  };
  const stack = await deps.getStack(project.id, project.organizationId);
  if (!stack || stack.managementMode !== "managed" || stack.routingMode !== "openship-edge") {
    throw new AppError("This project is not configured for OpenShip Swarm Edge routing.", 409, "SWARM_EDGE_REQUIRED");
  }
  if (!stack.managerServerId) {
    throw new AppError("This Swarm stack has no configured manager for OpenShip Edge TLS.", 503, "SWARM_EDGE_UNAVAILABLE");
  }
  if (!domain.serviceId) {
    throw new AppError("A Swarm Edge domain must be attached to an exposed service.", 409, "SWARM_EDGE_SERVICE_REQUIRED");
  }
  const service = await deps.getService(domain.serviceId);
  if (!service || service.projectId !== project.id || service.kind !== "swarm" || !service.sourceServiceName || !service.enabled || !service.exposed) {
    throw new AppError("The service for this Swarm Edge domain is no longer exposed.", 409, "SWARM_EDGE_SERVICE_REQUIRED");
  }
  const endpoint = resolveServicePublicEndpoints(service).find(
    (candidate) =>
      candidate.domainType === "custom" &&
      candidate.customDomain?.trim().toLowerCase() === domain.hostname.toLowerCase(),
  );
  if (!endpoint?.port) {
    throw new AppError("The Swarm Edge domain no longer has a valid exposed container port.", 409, "SWARM_EDGE_PORT_REQUIRED");
  }
  const platform = await deps.resolvePlatform(stack.managerServerId, project.organizationId);
  const manager = deps.createManager(platform);
  return createSwarmEdgeSslProvider({
    domain: domain.hostname,
    serviceDnsName: swarmEdgeServiceDnsName(stack.stackName, service.sourceServiceName),
    port: endpoint.port,
  }, manager);
}
