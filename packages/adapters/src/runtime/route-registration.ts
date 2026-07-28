import { DeployError, safeErrorMessage } from "@repo/core";
import { posix as pathPosix } from "node:path";

import type { RouteConfig } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { DeployRouting, DeploySsl } from "./deploy-pipeline";

export interface RoutedDomainInput {
  hostname: string;
  tls: boolean;
  provisionSsl?: boolean;
  targetPort?: number;
  targetPath?: string;
}

export interface RouteRegistrationOptions {
  /** If set, the domain matching this hostname gets a /_openship/hooks/ location */
  webhookDomain?: string | null;
  /** The proxy target for webhook requests (e.g. http://127.0.0.1:4000/api/webhooks/) */
  webhookProxy?: string;
}

/**
 * Register the deployment's domain routes. Returns a list of per-domain routing
 * WARNINGS (empty = all good) instead of throwing.
 *
 * Domains are OPTIONAL and routing runs AFTER the container is started + healthy
 * (see deploy-pipeline order), so a routing failure must NEVER fail the deploy:
 * the app is already up. Each domain that can't be routed (bad/missing upstream,
 * invalid target, nginx reload failure, …) is logged and collected here; the
 * caller records the warnings so the project shows "routing action required" and
 * the user retries from the Domains tab / next deploy. SSL was already
 * best-effort; this extends the same treatment to the route itself.
 */
export async function registerResolvedRoutes(
  logger: BuildLogger,
  routing: DeployRouting | undefined,
  ssl: DeploySsl | undefined,
  domains: RoutedDomainInput[],
  routeTarget: Omit<RouteConfig, "domain" | "tls"> | null,
  routeTargetsByPort?: Map<number, Omit<RouteConfig, "domain" | "tls">>,
  options?: RouteRegistrationOptions,
): Promise<string[]> {
  const warnings: string[] = [];

  if (!routing || domains.length === 0) {
    if (domains.length === 0) {
      logger.log("No domains configured - skipping routing for this deployment.\n", "warn");
    }
    return warnings;
  }

  if (!routeTarget) {
    return warnings;
  }

  // Captured after the guards so the type is narrowed inside the closure below.
  const routingProvider = routing;
  const baseRouteTarget = routeTarget;

  // Route ONE domain — throws on any failure; the loop turns that into a
  // collected warning so an optional domain never fails the deploy.
  const registerOne = async (domain: RoutedDomainInput): Promise<void> => {
    let routeConfig: RouteConfig;
    const hasPortTarget = domain.targetPort !== undefined;
    const hasPathTarget = typeof domain.targetPath === "string";

    if (hasPortTarget === hasPathTarget) {
      throw new DeployError(
        `Route ${domain.hostname} must target exactly one destination`,
        "INVALID_ROUTE_TARGET",
      );
    }

    const resolvedRouteTarget =
      domain.targetPort !== undefined
        ? routeTargetsByPort?.get(domain.targetPort) ?? baseRouteTarget
        : baseRouteTarget;
    const targetUrl = (resolvedRouteTarget as { targetUrl?: string }).targetUrl;
    const staticRoot = (resolvedRouteTarget as { staticRoot?: string }).staticRoot;

    // Source-of-truth registration log: show the RESOLVED upstream (ip:port) or
    // static root, plus the target port/path + tls — so a wrong or MISSING
    // upstream (the "route never registered → 404" case) is visible in the
    // deploy log instead of a bare "Registering route for <host>".
    const upstream = hasPortTarget
      ? typeof targetUrl === "string"
        ? targetUrl
        : "⚠ NO UPSTREAM RESOLVED — container IP/port did not resolve; route will NOT serve"
      : typeof staticRoot === "string"
        ? `static:${staticRoot}`
        : "⚠ NO STATIC ROOT RESOLVED";
    logger.log(
      `Registering route ${domain.hostname} → ${upstream} ` +
        `[${hasPortTarget ? `container port ${domain.targetPort}` : `path ${domain.targetPath}`}, tls=${domain.tls}]\n`,
    );

    if (hasPortTarget && typeof targetUrl === "string") {
      routeConfig = { domain: domain.hostname, tls: domain.tls, targetUrl };
    } else if (hasPathTarget && typeof staticRoot === "string") {
      const targetPath = domain.targetPath!;
      routeConfig = {
        domain: domain.hostname,
        tls: domain.tls,
        staticRoot: targetPath === "/"
          ? staticRoot
          : pathPosix.join(staticRoot, targetPath.slice(1)),
      };
    } else {
      throw new DeployError("Resolved route target is invalid", "INVALID_ROUTE_TARGET");
    }

    // Add webhook proxy location if this domain is the project's webhook domain
    if (options?.webhookDomain && domain.hostname === options.webhookDomain && options.webhookProxy) {
      routeConfig.webhookProxy = options.webhookProxy;
    }

    await routingProvider.registerRoute(routeConfig);

    if (domain.provisionSsl && ssl) {
      logger.log(`Checking SSL for ${domain.hostname}...\n`);
      // SSL is best-effort. The HTTP route is already written to disk
      // and reachable on port 80, which is what serves the ACME HTTP-01
      // challenge — so even when certbot fails right now (rate limit,
      // upstream Let's Encrypt outage, an unverified-custom-domain that
      // somehow slipped past the verified gate in buildProjectRouteDomains)
      // the user can still hit the box. The cert gets retried from the
      // Domains tab (POST /domains/:id/verify), from /renew-all, or on
      // the next deploy. Failing the whole deploy because of one cert is
      // a deeply hostile UX — the box is up, treat SSL as a follow-up.
      try {
        await ssl.provisionCert(domain.hostname);
      } catch (err) {
        const message = safeErrorMessage(err);
        logger.log(
          `SSL provisioning failed for ${domain.hostname} (route is up on HTTP, retry from the Domains tab): ${message}\n`,
          "warn",
        );
      }
    }
  };

  for (const domain of domains) {
    try {
      await registerOne(domain);
    } catch (err) {
      // A failed domain never fails the deploy — the container is already up.
      const message = safeErrorMessage(err);
      logger.log(
        `Routing failed for ${domain.hostname} (deploy continues; the app is up — fix DNS/routing and retry): ${message}\n`,
        "warn",
      );
      warnings.push(`${domain.hostname}: ${message}`);
    }
  }

  return warnings;
}