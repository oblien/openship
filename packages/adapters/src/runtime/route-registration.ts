import { DeployError, safeErrorMessage, type ProxySettings } from "@repo/core";
import { edgeDownExplanation } from "../system/edge-exec-error";
import { resolveServedStaticPath } from "./stack-output";

/**
 * Docker refuses inspect/exec against a container that is mid-restart with
 * "Container <id> is restarting, wait until the container is running". During a
 * deploy the app container can still be in its post-start stabilization window
 * (a normal 1–2 restart "dependency wait" — see the deploy stabilization watch,
 * #335) when routing resolves its upstream, so this error is TRANSIENT, not a
 * real routing failure. We retry briefly before recording a warning so a settling
 * container doesn't falsely mark the project "Action Required".
 *
 * NOT the sole retry gate: a crash-looping EDGE container surfaces the same daemon
 * phrase, because `explainDown` joins the enriched edge-down explanation to the raw
 * daemon line in one blob — so this predicate matches edge-down failures too. The
 * caller checks `edgeDownExplanation` FIRST and never retries those (retrying just
 * execs into the same dead edge); this predicate then only ever sees a genuine
 * app-container restart.
 */
function isContainerRestartingError(message: string): boolean {
  return /is restarting, wait until the container is running/i.test(message);
}

const ROUTE_RETRY_DELAY_MS = 1500;
const ROUTE_MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

import type { RouteConfig, RouteHostRedirect } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { DeployRouting, DeploySsl } from "./deploy-pipeline";

export interface RoutedDomainInput {
  hostname: string;
  tls: boolean;
  provisionSsl?: boolean;
  /** TLS terminates on the serving box — see RouteConfig.terminatesTlsLocally. */
  terminatesTlsLocally?: boolean;
  targetPort?: number;
  targetPath?: string;
  /** Canonical redirect to another host instead of serving — see
   *  RouteConfig.redirectHost. The destination below is still resolved and
   *  validated so dropping the redirect restores a serving route. */
  redirectHost?: RouteHostRedirect;
}

export interface RouteRegistrationOptions {
  /** If set, the domain matching this hostname gets a /_openship/hooks/ location */
  webhookDomain?: string | null;
  /** The proxy target for webhook requests (e.g. http://127.0.0.1:4000/api/webhooks/) */
  webhookProxy?: string;
  /**
   * Reverse-proxy tunables applied to EVERY domain of this deployment — upload
   * size limit, timeouts, buffering, gzip.
   *
   * An option rather than part of each `routeTarget`, because it is a property of
   * the project, not of a particular upstream: every vhost the project owns gets
   * the same values, and threading it through `resolveRoute`/`resolveTargetUrl`
   * would make each of them re-answer a question the project already answered.
   */
  proxy?: ProxySettings;
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
      domain.redirectHost
        ? `Registering route ${domain.hostname} → ${domain.redirectHost.statusCode} redirect to ` +
            `${domain.redirectHost.target} [tls=${domain.tls}]\n`
        : `Registering route ${domain.hostname} → ${upstream} ` +
            `[${hasPortTarget ? `container port ${domain.targetPort}` : `path ${domain.targetPath}`}, tls=${domain.tls}]\n`,
    );

    if (hasPortTarget && typeof targetUrl === "string") {
      routeConfig = {
        domain: domain.hostname,
        tls: domain.tls,
        terminatesTlsLocally: domain.terminatesTlsLocally,
        targetUrl,
      };
    } else if (hasPathTarget && typeof staticRoot === "string") {
      routeConfig = {
        domain: domain.hostname,
        tls: domain.tls,
        terminatesTlsLocally: domain.terminatesTlsLocally,
        // Shared rule — see resolveServedStaticPath. The live re-apply and the
        // output probe resolve the same path through it.
        staticRoot: resolveServedStaticPath(staticRoot, domain.targetPath!),
      };
    } else {
      throw new DeployError("Resolved route target is invalid", "INVALID_ROUTE_TARGET");
    }

    if (domain.redirectHost) {
      routeConfig.redirectHost = domain.redirectHost;
    }

    // Project-wide proxy tunables. Set for a static root too: `client_max_body_size`
    // and the body timeouts govern the REQUEST, which nginx reads before it decides
    // whether the response comes from a file or an upstream.
    if (options?.proxy) {
      routeConfig.proxy = options.proxy;
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
    let lastError = "";
    for (let attempt = 1; attempt <= ROUTE_MAX_ATTEMPTS; attempt++) {
      try {
        await registerOne(domain);
        lastError = "";
        break;
      } catch (err) {
        lastError = safeErrorMessage(err);
        // The EDGE container being down is not a transient this project grows out of:
        // every registerRoute execs into the edge, so if it is crash-looping, retrying
        // just execs into the same dead container four more times (6s wasted) and still
        // fails. Its blob carries the daemon's raw "is restarting" line alongside the
        // enriched explanation, so isContainerRestartingError alone would false-positive
        // here — the marker is the discriminator. Stop now; the warning below explains it.
        if (edgeDownExplanation(lastError)) break;
        // Only a genuine app-container restart (its post-start stabilization window) is
        // worth waiting on — any other failure (bad upstream, invalid target, nginx
        // reload error) is recorded immediately so real problems aren't hidden behind a delay.
        if (attempt < ROUTE_MAX_ATTEMPTS && isContainerRestartingError(lastError)) {
          logger.log(
            `Routing ${domain.hostname}: target container is still starting up — ` +
              `retrying (${attempt}/${ROUTE_MAX_ATTEMPTS - 1})…\n`,
            "warn",
          );
          await sleep(ROUTE_RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }
    if (lastError) {
      // A failed domain never fails the deploy — the container is already up.
      const edgeDown = edgeDownExplanation(lastError);
      if (edgeDown) {
        // The edge is what's down, not this project — "fix DNS/routing and retry" would
        // send the operator after the wrong thing (and it reads absurd for a static app
        // with no container of its own). Surface the one-line explanation (cause +
        // remedy) instead of the raw daemon blob, and carry the marker into the warning
        // so downstream (deployWarning, the routing-unsynced flag) recognises edge-down.
        logger.log(`Routing ${domain.hostname} could not be applied — ${edgeDown}\n`, "warn");
        warnings.push(`${domain.hostname}: ${edgeDown}`);
      } else {
        logger.log(
          `Routing failed for ${domain.hostname} (deploy continues; the app is up — fix DNS/routing and retry): ${lastError}\n`,
          "warn",
        );
        warnings.push(`${domain.hostname}: ${lastError}`);
      }
    }
  }

  return warnings;
}