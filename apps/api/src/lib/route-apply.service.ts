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
  Platform,
  RouteProxyLocation,
  RouteRedirect,
  RouteHeaderRule,
  RouteHostRedirect,
} from "@repo/adapters";
import { safeErrorMessage, sanitizeProxySettings, type RoutingConfig } from "@repo/core";
import { platform } from "./controller-helpers";
import { resolveDeploymentRuntime } from "./deployment-runtime";
import {
  reapplyCloudProjectRoute,
  removeCloudProjectRoute,
  type CloudRouteProject,
} from "./cloud-route.service";
import { webhookProxyTarget } from "../config";

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
  /**
   * Canonical redirect to another host instead of serving (see
   * RouteConfig.redirectHost). Carried on the LIVE path too, so turning a
   * redirect on or off takes effect on save rather than waiting for a redeploy —
   * the same treatment a domain/port edit already gets.
   */
  redirectHost?: RouteHostRedirect;
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
  const routing =
    opts.routing ??
    (opts.deployment ? (await resolveDeploymentRuntime(opts.deployment)).routing : null);

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
            console.warn(`[route-apply] fallback removeRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`),
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

  const webhookHost = project.webhookDomain?.trim().toLowerCase() || null;
  // Sanitized here, not trusted from the row: the API validates on write, but a
  // value could also have been seeded from a repo config or an older schema, and
  // this string is interpolated into generated nginx config.
  const proxy = sanitizeProxySettings(project.routingConfig?.proxy);

  for (const r of removes) {
    await routing
      .removeRoute(r.hostname)
      .catch((err) =>
        console.warn(`[route-apply] removeRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`),
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
    await routing
      .registerRoute({
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
        ...(r.redirectHost ? { redirectHost: r.redirectHost } : {}),
      })
      .catch((err) =>
        console.warn(`[route-apply] registerRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`),
      );
  }
}
