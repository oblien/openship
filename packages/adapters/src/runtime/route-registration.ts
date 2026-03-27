import { DeployError } from "@repo/core";

import type { RouteConfig } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { DeployRouting, DeploySsl } from "./deploy-pipeline";

export interface RoutedDomainInput {
  hostname: string;
  tls: boolean;
  provisionSsl?: boolean;
}

export async function registerResolvedRoutes(
  logger: BuildLogger,
  routing: DeployRouting | undefined,
  ssl: DeploySsl | undefined,
  domains: RoutedDomainInput[],
  routeTarget: Omit<RouteConfig, "domain" | "tls"> | null,
): Promise<void> {
  if (!routing || domains.length === 0) {
    if (domains.length === 0) {
      logger.log("No domains configured — skipping routing for this deployment.\n", "warn");
    }
    return;
  }

  if (!routeTarget) {
    return;
  }

  for (const domain of domains) {
    logger.log(`Registering route for ${domain.hostname}...\n`);

    let routeConfig: RouteConfig;
    const targetUrl = (routeTarget as { targetUrl?: string }).targetUrl;
    const staticRoot = (routeTarget as { staticRoot?: string }).staticRoot;

    if (typeof targetUrl === "string") {
      routeConfig = { domain: domain.hostname, tls: domain.tls, targetUrl };
    } else if (typeof staticRoot === "string") {
      routeConfig = { domain: domain.hostname, tls: domain.tls, staticRoot };
    } else {
      throw new DeployError("Resolved route target is invalid", "INVALID_ROUTE_TARGET");
    }

    await routing.registerRoute(routeConfig);

    if (domain.provisionSsl && ssl) {
      logger.log(`Checking SSL for ${domain.hostname}...\n`);
      await ssl.provisionCert(domain.hostname);
    }
  }
}