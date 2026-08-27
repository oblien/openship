/**
 * Single entry point for (re)applying a project's LIVE routes on a mutation
 * (service edit/delete, single-app publicEndpoints edit, webhook-domain set).
 *
 * Every edit path funnels through here so the routing surface is chosen ONCE,
 * consistently, and the webhook-proxy + best-effort semantics live in one place
 * rather than being copy-pasted per caller:
 *   - cloud project      → the runtime's page/workspace primitives
 *                          (cloud-route.service; the CloudInfraProvider routing
 *                          stub is a no-op).
 *   - self-hosted target → the DEPLOYMENT'S OWN routing provider (the local box,
 *                          or a remote server/sandbox over SSH) resolved via
 *                          resolveDeploymentRuntime — never the global
 *                          platform() singleton, which only ever targets the
 *                          orchestrator's local openresty.
 *
 * Callers compute the targets (the upstream differs: a service uses its
 * container-row IP, a single-app uses the deployment container IP, the webhook
 * domain uses the primary service IP) and hand them here; the dispatch, the
 * webhook-proxy re-attach, and the error tolerance are shared.
 *
 * Best-effort: the DB row is already committed by the caller, so a routing
 * failure logs and defers to the next deploy rather than failing the request.
 */

import type { Deployment } from "@repo/db";
import type {
  EdgeProxyApi,
  Platform,
  RouteProxyLocation,
  RouteRedirect,
  RouteHeaderRule,
  RouteHostRedirect,
} from "@repo/adapters";
import { edgeProxyFor } from "@repo/adapters";
import { safeErrorMessage, sanitizeProxySettings, type RoutingConfig } from "@repo/core";
import { platform } from "./controller-helpers";
import {
  disposePlatform,
  resolveDeploymentPlatform,
  type DeploymentMeta,
  type ResolvedDeploymentPlatform,
} from "./deployment-runtime";
import {
  reapplyCloudProjectRoute,
  removeCloudProjectRoute,
  type CloudRouteProject,
} from "./cloud-route.service";
import { webhookProxyTarget } from "../config";
import type { HostPortTargetIdentity } from "./host-port-target";
import {
  loopbackHostPortFromUrl,
  reserveObservedLoopbackPublishes,
  type ObservedLoopbackPublish,
} from "../modules/deployments/observed-host-port-claims";
import {
  convergeTargetHostPortClaimsUnlocked,
  prepareTargetPinnedHostPorts,
  withHostPortTargetLock,
} from "../modules/deployments/pinned-host-ports";

export interface RouteReconcileProject extends CloudRouteProject {
  webhookDomain?: string | null;
  /**
   * The project's routing config. Read here for `proxy` (upload limit, timeouts,
   * buffering, gzip) so EVERY live route apply picks it up from one place —
   * per-caller threading is how a domain edit and a redeploy end up emitting
   * different vhosts for the same project.
   */
  routingConfig?: RoutingConfig | null;
}

export interface RouteRegister {
  hostname: string;
  /** Self-hosted upstream, e.g. `http://<ip>:<port>`. Required for self-hosted. */
  targetUrl?: string;
  /**
   * Serve this domain's `/` from FILES on the host instead of proxying to an
   * upstream — `root <dir>; try_files $uri $uri/ /index.html;`.
   *
   * Mutually exclusive with `targetUrl`, and it composes with `proxyLocations`:
   * `registerRoute` emits the extra path-prefix locations before `location /`, so a
   * static frontend at `/` alongside a backend at `/api/` is ONE vhost with no web
   * server of its own. Self-hosted only — Oblien runs the workload on cloud, so
   * there is no host directory to serve and those keep a served container.
   */
  staticRoot?: string;
  /** Cloud target port (workspace expose / domains.connect). */
  port?: number;
  isCustomDomain: boolean;
  /**
   * Force (`true`) or suppress (`false`) the `/_openship/hooks/` webhook-proxy
   * location. Omit to auto-detect from the project's `webhookDomain` — callers
   * setting the webhook domain pass it explicitly because the project row isn't
   * updated yet at call time.
   */
  webhook?: boolean;
  /**
   * Composite single-domain routing compiled from the project's vercel.json
   * (`compileVercelRouting`): extra path-proxy locations (e.g. `/api/` → backend),
   * redirects, and response headers. Passed straight to `registerRoute`.
   */
  proxyLocations?: RouteProxyLocation[];
  redirects?: RouteRedirect[];
  headerRules?: RouteHeaderRule[];
  /** vercel.json `cleanUrls` / `trailingSlash`. Honoured for a `staticRoot` route only
   *  (registerRoute enforces that) — a proxied app's framework owns its URL shape. */
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  /**
   * Canonical redirect to another host instead of serving (see
   * RouteConfig.redirectHost). Carried on the LIVE path too, so turning a
   * redirect on or off takes effect on save rather than waiting for a redeploy —
   * the same treatment a domain/port edit already gets.
   */
  redirectHost?: RouteHostRedirect;
  /**
   * Stable workload ownership for every loopback upstream this vhost dials,
   * including `proxyLocations`. Required for loopback routes: a host-port URL
   * alone cannot identify which service/container port owns the bind.
   */
  observedLoopbackPublishes?: ObservedLoopbackPublish[];
}

export interface RouteRemove {
  hostname: string;
  isCustomDomain: boolean;
}

export async function reconcileProjectRoutes(
  project: RouteReconcileProject,
  opts: {
    /** Active deployment — resolves the self-hosted routing host when `routing` isn't given. */
    deployment?: Deployment | null;
    /** Pre-resolved self-hosted routing (avoids a second resolveDeploymentRuntime). */
    routing?: Platform["routing"];
    /** Required alongside pre-resolved routing when a register dials loopback. */
    hostPortTarget?: HostPortTargetIdentity | null;
    /** Strict inventory for a pre-resolved routing target. */
    edgeProxy?: Pick<EdgeProxyApi, "listLoopbackUpstreamPortsStrict">;
    registers?: RouteRegister[];
    removes?: RouteRemove[];
  },
): Promise<void> {
  const registers = opts.registers ?? [];
  const removes = opts.removes ?? [];
  if (registers.length === 0 && removes.length === 0) return;

  // Cloud: page/workspace primitives. The webhook proxy is an nginx concern, so
  // it does not apply here (cloud webhook delivery uses a different path).
  if (project.cloudWorkspaceId) {
    for (const r of removes) await removeCloudProjectRoute(project, r);
    for (const r of registers) {
      await reapplyCloudProjectRoute(project, {
        hostname: r.hostname,
        port: r.port,
        isCustomDomain: r.isCustomDomain,
      });
    }
    return;
  }

  // Self-hosted: the deployment's own routing provider, resolved once.
  //
  // `resolved` is held so its transport can be released in the `finally` below:
  // resolving a platform for a REMOTE server eagerly binds a Docker-over-SSH
  // loopback bridge, and this path only ever wanted `.routing` — so it was
  // binding a listener per route apply and never closing it.
  let resolved: ResolvedDeploymentPlatform | null = null;
  if (!opts.routing && opts.deployment) {
    resolved = await resolveDeploymentPlatform((opts.deployment.meta ?? {}) as DeploymentMeta, {
      organizationId: opts.deployment.organizationId,
    });
  }
  const routing = opts.routing ?? resolved?.platform.routing ?? null;
  try {
    if (!routing) {
      // No deployment routing to resolve (e.g. the active deployment was already
      // destroyed, clearing activeDeploymentId). We can't safely REGISTER to an
      // unknown host, but a stray vhost from a prior deploy lives on the local
      // orchestrator, so run REMOVES there — restoring the opportunistic teardown
      // the pre-consolidation code did unconditionally (otherwise the vhost is
      // orphaned → stale 502). On remote-server deploys the route isn't local, so
      // this is a harmless no-op.
      if (removes.length > 0) {
        // Teardown runs against the API's OWN routing context. For a single-box
        // install that IS the edge; for a containerized API or a remote/takeover'd
        // target it isn't, so the stray vhost may actually live on another host and
        // these removes are a no-op there. Non-fatal either way, but log it so an
        // orphaned vhost that survives isn't mistaken for a completed teardown.
        console.warn(
          `[route-apply] no deployment routing resolved — running ${removes.length} route removal(s) ` +
            `against the API's own edge context; a remote/takeover'd edge may retain the vhost until redeploy`,
        );
        const local = platform().routing;
        for (const r of removes) {
          await local
            .removeRoute(r.hostname)
            .catch((err) =>
              console.warn(
                `[route-apply] fallback removeRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`,
              ),
            );
        }
      }
      if (registers.length > 0) {
        console.warn(
          `[route-apply] no deployment routing resolved — ${registers.length} route(s) not applied (redeploy to re-sync)`,
        );
      }
      return;
    }

    const loopbackPublishesByRegister = new Map<RouteRegister, ObservedLoopbackPublish[]>();
    const dialledLoopbackPorts = new Set<number>();
    const missingOwnershipPorts = new Set<number>();
    for (const register of registers) {
      // A canonical host redirect emits no upstream locations. A static route
      // emits only its explicit proxyLocations; its targetUrl (when supplied by
      // an older caller) is not rendered as location `/` and must not pin a port.
      const renderedUrls = register.redirectHost
        ? []
        : [
            ...(register.staticRoot ? [] : [register.targetUrl]),
            ...(register.proxyLocations?.map((location) => location.targetUrl) ?? []),
          ];
      const registerPorts = new Set<number>();
      for (const url of renderedUrls) {
        const port = loopbackHostPortFromUrl(url);
        if (!port) continue;
        registerPorts.add(port);
        dialledLoopbackPorts.add(port);
      }
      const publishes = (register.observedLoopbackPublishes ?? []).filter((publish) =>
        registerPorts.has(publish.hostPort),
      );
      loopbackPublishesByRegister.set(register, publishes);
      const describedPorts = new Set(publishes.map((publish) => publish.hostPort));
      for (const port of registerPorts) {
        if (!describedPorts.has(port)) missingOwnershipPorts.add(port);
      }
    }
    // Keep the routing provider, strict inventory, and physical identity from
    // the same resolved platform. Removal-only and loopback→container-IP/static
    // mutations need this context too: they create no new loopback publish, but
    // they are exactly when an obsolete durable claim becomes reclaimable.
    const hostPortTarget = resolved?.hostPortTarget ?? opts.hostPortTarget ?? null;
    const edgeProxy = resolved?.platform.executor
      ? edgeProxyFor(resolved.platform.executor, "openresty", { ours: true })
      : (opts.edgeProxy ?? null);
    const claimContext =
      hostPortTarget && edgeProxy ? { target: hostPortTarget, edgeProxy } : undefined;

    let loopbackGuard:
      | {
          target: HostPortTargetIdentity;
          edgeProxy: Pick<EdgeProxyApi, "listLoopbackUpstreamPortsStrict">;
          publishes: ObservedLoopbackPublish[];
        }
      | undefined;
    if (dialledLoopbackPorts.size > 0) {
      // Reuse the per-vhost filtering above rather than rebuilding this list
      // against the global port set. Otherwise stray metadata attached to one
      // register could reserve a different register's port even though that
      // first vhost never renders it.
      const publishes = registers.flatMap(
        (register) => loopbackPublishesByRegister.get(register) ?? [],
      );
      if (missingOwnershipPorts.size > 0) {
        throw new Error(
          `Refusing loopback route without stable workload ownership for host port(s): ${[...missingOwnershipPorts].join(", ")}`,
        );
      }
      if (!hostPortTarget) {
        throw new Error("Refusing loopback route without a resolved physical host-port target");
      }
      if (!edgeProxy) {
        throw new Error("Refusing loopback route without a strict target edge inventory");
      }
      loopbackGuard = { target: hostPortTarget, edgeProxy, publishes };
    }

    const applyRoutes = async () => {
      if (loopbackGuard) {
        // A legacy/deleted DB row can leave a vhost with no durable claim. Import
        // every observed edge port into the canonical namespace before trusting a
        // stored/live upstream. An unreadable edge rejects here; it is never treated
        // as empty.
        await prepareTargetPinnedHostPorts({
          target: loopbackGuard.target,
          edgeProxy: loopbackGuard.edgeProxy,
        });
        // The collision gate is deliberately before removals and registrations.
        // A foreign owner conflict propagates; no route mutation occurs.
        await reserveObservedLoopbackPublishes({
          target: loopbackGuard.target,
          projectId: project.id,
          publishes: loopbackGuard.publishes,
        });
      }

      const webhookHost = project.webhookDomain?.trim().toLowerCase() || null;
      // Sanitized here, not trusted from the row: the API validates on write, but a
      // value could also have been seeded from a repo config or an older schema, and
      // this string is interpolated into generated nginx config.
      const proxy = sanitizeProxySettings(project.routingConfig?.proxy);
      const successfulPublishes: ObservedLoopbackPublish[] = [];

      for (const r of removes) {
        await routing
          .removeRoute(r.hostname)
          .catch((err) =>
            console.warn(
              `[route-apply] removeRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`,
            ),
          );
      }

      for (const r of registers) {
        // A route serves `/` from ONE of two things: a host directory (static, files
        // on disk) or an upstream. Neither → nothing to serve.
        if (!r.staticRoot && !r.targetUrl) {
          console.warn(
            `[route-apply] no upstream or static root resolved for ${r.hostname} — route not applied (redeploy to re-sync)`,
          );
          continue;
        }
        const isWebhook = r.webhook ?? (!!webhookHost && r.hostname.toLowerCase() === webhookHost);
        try {
          await routing.registerRoute({
            domain: r.hostname,
            tls: true,
            // A custom domain's TLS is ours to terminate, so the edge must keep a :443
            // listener up for it even before its cert exists — otherwise HTTPS for it
            // falls through to the edge's 443 catch-all, which answers with a
            // domain-less placeholder cert and the branded not-found page, i.e. the
            // domain reads as unconfigured rather than pending (#308).
            // A free *.opsh.io host is fronted by Cloud's edge; not ours.
            terminatesTlsLocally: r.isCustomDomain,
            // staticRoot wins when present: it is the more specific instruction, and a
            // caller that resolved a doc root has already decided this domain serves
            // files. registerRoute keys off which one is set.
            ...(r.staticRoot ? { staticRoot: r.staticRoot } : { targetUrl: r.targetUrl! }),
            // Project-wide tunables, applied on the LIVE path too so raising an upload
            // limit takes effect on save rather than waiting for a redeploy — the same
            // treatment a domain/port edit already gets.
            ...(proxy ? { proxy } : {}),
            ...(isWebhook ? { webhookProxy: webhookProxyTarget } : {}),
            ...(r.proxyLocations?.length ? { proxyLocations: r.proxyLocations } : {}),
            ...(r.redirects?.length ? { redirects: r.redirects } : {}),
            ...(r.headerRules?.length ? { headerRules: r.headerRules } : {}),
            ...(r.cleanUrls ? { cleanUrls: true } : {}),
            ...(r.trailingSlash === undefined ? {} : { trailingSlash: r.trailingSlash }),
            ...(r.redirectHost ? { redirectHost: r.redirectHost } : {}),
          });
          successfulPublishes.push(...(loopbackPublishesByRegister.get(r) ?? []));
        } catch (err) {
          console.warn(
            `[route-apply] registerRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`,
          );
        }
      }

      if (claimContext) {
        try {
          await convergeTargetHostPortClaimsUnlocked({
            target: claimContext.target,
            projectId: project.id,
            // A failed best-effort registration is not desired live state. The
            // fresh edge scan below still retains any old route it can observe,
            // while a pre-reserved port that never became reachable is released.
            desiredPublishes: successfulPublishes,
            edgeProxy: claimContext.edgeProxy,
          });
        } catch (error) {
          // The route mutation is already best-effort and the safe fallback is
          // to KEEP every claim. Surface the deferred cleanup without turning a
          // successfully committed DB edit into an HTTP failure.
          console.warn(
            `[route-apply] host-port claim convergence deferred (claims retained): ${safeErrorMessage(error)}`,
          );
        }
      }
    };

    if (claimContext) {
      await withHostPortTargetLock(claimContext.target, applyRoutes);
    } else {
      await applyRoutes();
    }
  } finally {
    // Only ours to release when we resolved it — a caller-supplied `opts.routing`
    // belongs to whoever built it and may still be in use after we return.
    disposePlatform(resolved);
  }
}
