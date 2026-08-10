import { repos, type Domain, type Project, type Service } from "@repo/db";
import type { RoutedDomainInput, SslProvider, SslResult } from "@repo/adapters";
import { SYSTEM, ConflictError, resolveServiceHostnameLabel, normalizeCustomHostname, safeErrorMessage } from "@repo/core";
import { env } from "../config/env";
import { serviceKind } from "./deployable-service";
import { resolveServicePublicEndpoints, type StoredPublicEndpoint } from "./public-endpoints";
import { acmeIssueLockKey, LOCAL_ACME_SCOPE, resolveSslPatch, sslIssueLockKey } from "./domain-ssl";
import { resolveRouteRedirect } from "./domain-redirect";
import { createProvisionLock } from "./provision-lock";
import { generateToken } from "./domain-token";

export interface PlannedRouteDomain {
  hostname: string;
  tls: boolean;
  /**
   * The serving host must have the local TLS toolchain ready for this route.
   * This is intentionally broader than `provisionSsl`: pending custom domains
   * need certbot installed during their first deploy even though issuance waits
   * for verification.
   */
  requiresSslTooling: boolean;
  provisionSsl: boolean;
  /**
   * TLS for this host terminates on the serving box, so the edge must keep a :443
   * listener up for it from the moment the route exists (a temporary self-signed
   * cert until the real one lands). Broader than `provisionSsl`/`requiresSslTooling`:
   * it also covers a manual-SSL host whose cert hasn't been uploaded yet, and it
   * stays true after a failed issuance — both are states where a missing listener
   * sends HTTPS for a domain we DO route to the edge's 443 catch-all, which answers
   * every unrouted name with a placeholder cert and a not-found page (#308, #431).
   */
  terminatesTlsLocally: boolean;
  isCloud: boolean;
  targetPort?: number;
  targetPath?: string;
  domainType?: "free" | "custom";
  managedSubdomain?: string;
  serviceId?: string;
  isPrimary?: boolean;
  createIfMissing?: boolean;
  verified?: boolean;
  /** Canonical redirect: serve a 30x to this hostname instead of the app. Kept as
   *  the raw stored value; `resolveRouteRedirect` decides whether it's live. */
  redirectTo?: string | null;
  redirectStatus?: number | null;
}

export function getRoutingBaseDomain(): string {
  return env.HOST_DOMAIN || SYSTEM.DOMAINS.CLOUD_DOMAIN;
}

/**
 * Self-hosted runtimes whose custom-domain routes are fronted by OpenResty
 * and need a certbot-issued cert (the NginxProvider SSL path). Both `bare`
 * and `docker` self-hosted deploys go through the SAME OpenResty + certbot
 * provider (see platform.ts → createInfraProvider, which returns NginxProvider
 * regardless of runtime mode). `cloud` uses managed SSL; `desktop` (bare +
 * noop infra) has no real SSL provider. Historically this was gated to `bare`
 * only, which silently skipped SSL for every Docker deployment — a custom
 * domain on a Docker app would stay on HTTP forever.
 */
function usesCertbotSsl(runtimeName: string): boolean {
  return runtimeName === "bare" || runtimeName === "docker";
}

export function resolveManagedHostname(hostname: string): { isManaged: boolean; subdomain?: string } {
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${baseDomain}`;

  if (!normalized.endsWith(suffix)) {
    return { isManaged: false };
  }

  const subdomain = normalized.slice(0, -suffix.length);
  return {
    isManaged: subdomain.length > 0,
    subdomain: subdomain || undefined,
  };
}

/**
 * Does TLS for `hostname` terminate on THIS box? See
 * {@link PlannedRouteDomain.terminatesTlsLocally}.
 *
 * For the callers that reach `registerRoute` WITHOUT going through the route
 * planner — route reconcile, compose single-domain composition, migration path
 * fan-out. They have to agree with the planner: a route registered without this
 * flag gets no :443 listener until its cert exists, and a routed domain with no TLS
 * listener is served by the edge's 443 catch-all instead — placeholder cert, branded
 * not-found page, which looks like the domain was never deployed (#308, #431).
 */
export function hostTerminatesTlsLocally(
  hostname: string,
  domain?: { externalIngress?: boolean | null } | null,
): boolean {
  // A managed *.opsh.io host is fronted by Openship Cloud's edge, which
  // terminates TLS and forwards to plain :80 here.
  if (resolveManagedHostname(hostname).isManaged) return false;
  return !domain?.externalIngress;
}

/**
 * Resolve a route's proxy destination. Precedence: explicit path > explicit
 * port > static release root ("/") > none. Single-sourced so the #345
 * static-root fallback can't drift between buildProjectRouteDomains' two loops.
 *
 * `targetPort` is tested with `!= null` (NOT `!== undefined`) because a domain
 * row's port is a nullable DB column: a portless row carries literal `null`, and
 * a `{ targetPort: null }` would slip past add()'s `=== undefined` guard and mint
 * a vhost with a broken upstream. `targetPath` stays a TRUTHY check so an empty
 * string falls through to the port branch — matching the original inline
 * ternaries exactly (a public endpoint's `port` is never null at runtime, so the
 * broader check is a safe no-op there).
 */
export function resolveRouteDestination(
  input: { targetPath?: string | null; targetPort?: number | null },
  isStatic?: boolean,
): { targetPort?: number; targetPath?: string } | undefined {
  // THE DEPLOYMENT'S SHAPE DECIDES, not the stored hint.
  //
  // `targetPath` and `targetPort` are meant to be mutually exclusive — "exactly
  // one of port / targetPath must be set (proxy vs static)", enforced in
  // routeDomainRowToPublicEndpoint. But `domain.targetPath` is a PERSISTED column,
  // so a hostname that once served a static path keeps it forever, and a later
  // port-based deploy of the same hostname sets `targetPort` alongside it without
  // anything clearing the old value.
  //
  // This used to test `targetPath` FIRST and unconditionally, so in that state the
  // stale path outranked the live port: the route plan said "serve files", the
  // pipeline resolved a static doc root, and `registerRoute` wrote a STATIC vhost
  // for a server app. The vhost overwrite was complete and correct — it just
  // rebuilt the PREVIOUS project's shape, so redeploying a proxy app onto a
  // hostname that once served static files brought the old static site back.
  //
  // Worse, it was self-perpetuating: the plan derived `targetPath` from the row,
  // and the reconcile below then patched the row to match the plan, so
  // `expected === existing` and the stale column could never be cleared. Deciding
  // from `isStatic` breaks that loop — a non-static deploy now plans
  // `targetPath: null`, which the reconcile finally writes back as a clear.
  if (isStatic) {
    // Serving FILES. A stored subpath only refines WHICH subdir of the release;
    // absent, serve the release root (#345).
    return { targetPath: input.targetPath || "/" };
  }
  // Serving a PORT. A `targetPath` left over from a previous static deployment of
  // this hostname is not a destination — it is stale state, and ignoring it here
  // is what lets the reconcile clear it.
  if (input.targetPort != null) return { targetPort: input.targetPort };
  return undefined;
}

export function buildProjectRouteDomains(opts: {
  project: Project;
  projectDomains: Domain[];
  managedSlug?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
    redirectTo?: string | null;
    redirectStatus?: number | null;
  }>;
  runtimeName: string;
  usesManagedRouting: boolean;
  /**
   * #345: a static (file-served) deploy has NO port to proxy to — it serves the
   * built release dir off disk. A domain/endpoint with no explicit destination
   * must therefore default to serving the release ROOT (`targetPath: "/"`), not
   * be dropped as "unroutable". Dropping it left `sites-enabled` empty, so every
   * request fell through to the OpenResty default_server 404 even though the
   * files were built and the deploy reported ready.
   */
  isStatic?: boolean;
}): PlannedRouteDomain[] {
  const { projectDomains, managedSlug, publicEndpoints, runtimeName, usesManagedRouting, isStatic } = opts;
  const baseDomain = getRoutingBaseDomain();
  const seen = new Set<string>();
  const planned: PlannedRouteDomain[] = [];
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );

  // Push a single planned route. A route MUST target exactly one
  // destination (port or path) — calls without one are silently ignored.
  // SSL is provisioned only for DNS-verified custom domains on the bare
  // runtime: free managed (*.opsh.io) routes skip certbot (we own that
  // DNS), and a pending custom domain gets an HTTP-only route until
  // /verify issues its cert (see domain.service.ts → verifyDomain). When
  // isPrimary is omitted, the first route added wins.
  const add = (
    hostname: string,
    route: {
      domainType: "free" | "custom";
      destination?: { targetPort?: number; targetPath?: string };
      skipSsl?: boolean;
      isPrimary?: boolean;
      verified?: boolean;
      redirectTo?: string | null;
      redirectStatus?: number | null;
    },
  ) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    if (!route.destination?.targetPath && route.destination?.targetPort === undefined) return;
    seen.add(normalized);

    const managed = resolveManagedHostname(normalized);
    const domainRow = domainByHostname.get(normalized);
    const isVerified = managed.isManaged
      ? true
      : route.verified ?? domainRow?.verified ?? false;
    // Externally-managed ingress (Cloudflare Tunnel / LB): TLS terminates
    // upstream and DNS points at the user's edge, so serve a plain-HTTP route
    // (tls:false) and never run certbot for this host.
    const external = !!domainRow?.externalIngress;
    // Operator-supplied cert (BYO / Cloudflare Full-strict): serve TLS from the
    // uploaded cert and never run certbot, even behind an external edge.
    const manualSsl = !!domainRow?.manualSsl;

    const requiresSslTooling =
      usesCertbotSsl(runtimeName) &&
      !managed.isManaged &&
      !route.skipSsl &&
      !external &&
      !manualSsl;

    planned.push({
      hostname: normalized,
      tls: !external || manualSsl,
      requiresSslTooling,
      // Ours to terminate unless an upstream ingress owns it (externalIngress) or
      // it's a managed *.opsh.io host fronted by Openship Cloud's edge.
      terminatesTlsLocally: !external && !managed.isManaged,
      // Attempt issuance on the FIRST deploy of an unverified custom domain
      // (sslStatus still "none" = no attempt yet, by any path) — issuing IS the
      // verification on self-hosted, so this makes the domain Live at end-of-deploy
      // instead of waiting on the 13-min cron or a manual Verify. A domain whose
      // first attempt already ran (error/provisioning/active) is NOT re-attempted
      // here; a verified domain issues as before. [#291/#304 follow-up]
      provisionSsl: requiresSslTooling && (isVerified || domainRow?.sslStatus === "none"),
      isCloud: managed.isManaged,
      ...(route.destination?.targetPort !== undefined
        ? { targetPort: route.destination.targetPort }
        : {}),
      ...(route.destination?.targetPath ? { targetPath: route.destination.targetPath } : {}),
      domainType: route.domainType,
      managedSubdomain: managed.subdomain,
      isPrimary: route.isPrimary ?? planned.length === 0,
      createIfMissing: true,
      verified: isVerified,
      // Prefer the caller's value (the submitted endpoint) over the row, so a
      // redirect set in the same save applies on this deploy rather than the next.
      redirectTo: route.redirectTo ?? domainRow?.redirectTo ?? null,
      redirectStatus: route.redirectStatus ?? domainRow?.redirectStatus ?? null,
    });
  };

  if (publicEndpoints?.length) {
    for (const [index, endpoint] of publicEndpoints.entries()) {
      const destination = resolveRouteDestination(
        { targetPath: endpoint.targetPath, targetPort: endpoint.port },
        isStatic,
      );

      if (!destination) {
        continue;
      }

      // Attach EITHER the operator's custom domain OR a free
      // <slug>.opsh.io fallback — never both. The free managed URL is
      // served by Openship Cloud's edge (runPostDeploySync →
      // ensureManagedEdgeProxy), so a self-hosted box can't serve it
      // alone; once the operator points their own domain at the box, that
      // domain is the deploy URL and a free slug they never asked for is
      // just an unservable route plus a failing edge sync. Same rule as
      // preflight.ts. The chosen route is primary for the first endpoint
      // (deploy URL, analytics, etc.).
      if (endpoint.domainType === "custom" && endpoint.customDomain) {
        add(endpoint.customDomain, {
          domainType: "custom",
          destination,
          isPrimary: index === 0,
          redirectTo: endpoint.redirectTo,
          redirectStatus: endpoint.redirectStatus,
        });
        continue;
      }

      const routeSlug = endpoint.domain || managedSlug;
      if (routeSlug && usesManagedRouting) {
        add(`${routeSlug}.${baseDomain}`, {
          domainType: "free",
          destination,
          skipSsl: true,
          isPrimary: index === 0,
          redirectTo: endpoint.redirectTo,
          redirectStatus: endpoint.redirectStatus,
        });
      }
    }

    // #345: a static deploy has no port, so its endpoints above may all be
    // destination-less — and Domains-tab custom rows never appear in
    // `publicEndpoints` at all. Fall through to the project's own domain rows
    // below (the `seen` set dedups anything already routed) so those still get
    // a root route instead of leaving `sites-enabled` empty → default 404.
    if (!isStatic) return planned;
  }

  // Route the project's own domain rows directly. A domain only routes if its
  // row carries a destination (port or path) — add() ignores the rest — EXCEPT
  // for a static deploy, where a destination-less row defaults to serving the
  // release root ("/"). Pending custom domains still get an HTTP-only route so
  // certbot --webroot can answer the ACME challenge; add() gates SSL on
  // domain.verified.
  for (const domain of projectDomains) {
    if (domain.serviceId) continue;
    if (domain.domainType === "free" && !domain.verified) continue;
    add(domain.hostname, {
      domainType: domain.domainType === "free" ? "free" : "custom",
      skipSsl: domain.domainType === "free",
      destination: resolveRouteDestination(
        { targetPath: domain.targetPath, targetPort: domain.targetPort },
        isStatic,
      ),
      isPrimary: domain.isPrimary,
      verified: domain.verified,
      redirectTo: domain.redirectTo,
      redirectStatus: domain.redirectStatus,
    });
  }

  return planned;
}

/**
 * The hostname a single service endpoint routes on: a normalized custom domain,
 * or a managed `<label>.<baseDomain>` free host. Returns null when a custom
 * endpoint carries no customDomain, or a free endpoint runs on a box that
 * doesn't do managed routing — the caller then skips the endpoint.
 *
 * NOT interchangeable with resolveServiceEndpointUrls (display URLs off
 * CLOUD_DOMAIN, no normalize) or the single-app free-host builder in
 * buildProjectRouteDomains. The managed suffix MUST be getRoutingBaseDomain():
 * the result feeds resolveManagedHostname for the SSL gate, so CLOUD_DOMAIN here
 * would misclassify a custom-HOST_DOMAIN box's free host as unmanaged and certbot
 * a host it doesn't own. The custom branch is TERMINAL — a custom endpoint with
 * no customDomain must NOT fall through to the managed builder (that would hand
 * it a free hostname and route/cert it wrongly).
 */
export function resolveServiceEndpointHostname(
  project: Project,
  service: Service,
  endpoint: Pick<StoredPublicEndpoint, "domainType" | "customDomain" | "domain">,
  usesManagedRouting: boolean,
): string | null {
  if (endpoint.domainType === "custom") {
    return endpoint.customDomain ? normalizeCustomHostname(endpoint.customDomain) : null;
  }
  if (!usesManagedRouting) return null;
  const label = resolveServiceHostnameLabel(
    project.slug ?? project.name,
    service.name,
    endpoint.domain,
    serviceKind(service),
  );
  return `${label}.${getRoutingBaseDomain()}`;
}

export function buildServiceRouteDomains(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
  /** The project's domain rows keyed by hostname. Drives per-host SSL gating —
   *  same as the single-app path in add(): an external-ingress row serves plain
   *  HTTP (tls:false, no certbot), a manual-SSL row serves the uploaded cert,
   *  and certbot provisioning only fires for a VERIFIED custom domain. Omit on
   *  the edit/delete reconcile path, which registers routes but provisions no
   *  SSL — the SSL step runs on the deploy path, which always supplies it. */
  domainByHostname?: Map<string, Domain>;
}): PlannedRouteDomain[] {
  const { project, service, runtimeName, usesManagedRouting } = opts;
  if (!service.exposed) return [];

  // One route per public endpoint (a multi-port service — e.g. Convex's API
  // 3210 + HTTP actions 3211 — gets one hostname each). Falls back to the
  // single primary route synthesized from the scalar columns for pre-migration
  // / single-route services. See resolveServicePublicEndpoints.
  const endpoints = resolveServicePublicEndpoints(service);
  const planned: PlannedRouteDomain[] = [];
  const seen = new Set<string>();

  for (const endpoint of endpoints) {
    if (endpoint.port === undefined) continue;

    // Monorepo sub-apps always get a namespaced hostname (`<project>-<app>`).
    // Compose services keep the "frontend"/"web"/"app" → bare-project-label
    // shortcut (see defaultServiceHostnameLabel). Each endpoint's own free slug
    // overrides that default, so secondary ports get distinct hostnames.
    const hostname = resolveServiceEndpointHostname(project, service, endpoint, usesManagedRouting);

    if (!hostname) continue;
    const normalized = hostname.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const managed = resolveManagedHostname(hostname);
    const domainRow = opts.domainByHostname?.get(normalized);
    const external = !!domainRow?.externalIngress;
    const manualSsl = !!domainRow?.manualSsl;
    // Only certbot a custom domain that has passed DNS verification — mirrors
    // the single-app add() gate. A managed (free) host needs no challenge; a
    // still-pending custom host would only burn a Let's Encrypt failed attempt.
    // When the domain map isn't supplied (edit/delete reconcile, which doesn't
    // provision SSL), this stays false and no cert work is attempted.
    const isVerified = managed.isManaged ? true : (domainRow?.verified ?? false);
    const requiresSslTooling =
      usesCertbotSsl(runtimeName) &&
      endpoint.domainType === "custom" &&
      !external &&
      !manualSsl;

    planned.push({
      hostname,
      tls: !external || manualSsl,
      requiresSslTooling,
      // Same rule as the single-app path: a custom host on this box is ours to
      // terminate; a managed free host is Cloud's.
      terminatesTlsLocally: endpoint.domainType === "custom" && !external,
      // First-deploy issuance for an unverified custom service route — see the
      // single-app add() gate above for the rationale. [#291/#304 follow-up]
      provisionSsl: requiresSslTooling && (isVerified || domainRow?.sslStatus === "none"),
      isCloud: managed.isManaged,
      targetPort: endpoint.port,
      domainType: endpoint.domainType,
      managedSubdomain: managed.subdomain,
      serviceId: service.id,
      isPrimary: false,
      createIfMissing: true,
      verified: isVerified,
      // A service-scoped hostname can carry a redirect too (its own www sibling),
      // and it's stored on the same row — so read it from there rather than
      // silently ignoring it for compose/service routes.
      redirectTo: domainRow?.redirectTo ?? null,
      redirectStatus: domainRow?.redirectStatus ?? null,
    });
  }

  return planned;
}

/**
 * The custom hostnames a service CONFIGURES, independent of enabled/exposed.
 * Drives the derived domain-row lifecycle: a row is orphaned only when its
 * hostname leaves the service's config (cleared / renamed / switched to free),
 * NOT when routing is merely paused by unexposing — so a verified domain
 * survives an expose toggle. Lowercased + de-duped.
 */
export function serviceCustomHostnames(service: Service): string[] {
  const hosts = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    const hostname = normalizeCustomHostname(raw);
    if (hostname) hosts.add(hostname);
  };
  // Read the raw config, NOT resolveServicePublicEndpoints — that gates on
  // `exposed` (returns [] when paused), which would make an unexpose look like
  // a de-configuration and wrongly orphan the row. Multi-route config wins when
  // present; otherwise the scalar columns.
  if (service.publicEndpoints && service.publicEndpoints.length > 0) {
    for (const endpoint of service.publicEndpoints) {
      if (endpoint.domainType === "custom") add(endpoint.customDomain);
    }
  } else if (service.domainType === "custom") {
    add(service.customDomain);
  }
  return [...hosts];
}

/**
 * Back-compat single-route accessor: the service's PRIMARY public route (or
 * null). Callers that only touch the primary domain keep using this; the deploy
 * loop and edit reconcile use buildServiceRouteDomains for the full set.
 */
export function buildServiceRouteDomain(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
  domainByHostname?: Map<string, Domain>;
}): PlannedRouteDomain | null {
  return buildServiceRouteDomains(opts)[0] ?? null;
}

export function createTrackedSslProvider(
  ssl: SslProvider,
  domainByHostname: Map<string, Domain>,
  log?: (message: string) => void,
  /** {@link acmeIssueLockKey} scope — the serving server's id. Defaults to the
   *  local box, which is correct for a single-box install. */
  lockScope: string = LOCAL_ACME_SCOPE,
): SslProvider {
  // Persist via the shared no-clobber resolver: a verified cert → "active"; a
  // genuinely missing cert → "provisioning"; a transient read failure leaves the
  // row alone (so a redeploy that can't momentarily read an existing cert can't
  // downgrade a live "active" → "provisioning"). Same rule the on-demand path uses.
  const persist = async (hostname: string, result: SslResult) => {
    const domainRecord = domainByHostname.get(hostname.toLowerCase());
    if (domainRecord) {
      const patch = resolveSslPatch(domainRecord.sslStatus, result);
      if (patch) await repos.domain.updateSsl(domainRecord.id, patch);
    }
    return result;
  };

  // Deploy-time issuance. Unlike renew/verify this can be the FIRST attempt for a
  // still-unverified custom domain, so it carries extra obligations:
  //   • serialize on the SAME per-host lock the verify-pending cron uses, or a
  //     first deploy can race a concurrent cron issuance → duplicate ACME orders /
  //     HTTP-01 collision / rate-limit burn.
  //   • CATCH internally: `runDeployPipeline` discards this return value, so a
  //     thrown ACME error would persist nothing and leave sslStatus at "none" —
  //     re-firing the attempt on EVERY subsequent deploy (the rate-limit loop).
  //   • on success for an unverified row, flip verified+active (issuing IS
  //     verifying on self-hosted) so it's Live with no manual Verify. No promote —
  //     never steal an existing primary.
  //   • on a FIRST-attempt failure, mark sslStatus="error" + reason (the
  //     Action-Required dot); the domain's own `status` stays pending so the
  //     verify-pending cron keeps retrying. A VERIFIED row keeps resolveSslPatch
  //     (→ "provisioning") so the auto-heal sweep still covers it.
  const provisionCert = async (hostname: string): Promise<SslResult> => {
    const host = hostname.toLowerCase();
    const domainRecord = domainByHostname.get(host);
    const wasVerified = !!domainRecord?.verified;
    return createProvisionLock(sslIssueLockKey(host)).run(async () => {
      log?.(`Requesting SSL certificate for ${host}…`);
      let result: SslResult;
      let errorReason: string | null = null;
      try {
        // Nested per-box lock: a deploy routing BOTH `example.com` and
        // `www.example.com` issues two certificates in a row, and each certbot run
        // binds the same standalone challenge port. Without this they can also
        // collide with the pending-SSL sweep working on the other hostname.
        result = await createProvisionLock(acmeIssueLockKey(lockScope)).run(() =>
          ssl.provisionCert(host),
        );
      } catch (err) {
        errorReason = safeErrorMessage(err);
        result = { domain: host, expiresAt: "", issuer: "", verified: false, reason: "missing" };
      }

      // No row in the map (route-minted after the map was built) — nothing to
      // persist; the verify-pending cron / next deploy picks it up.
      if (!domainRecord) return result;

      // TLS handled elsewhere (desktop no-op / external ingress): not a failure,
      // never write "error".
      if (result.reason === "not_local") {
        log?.(`SSL for ${host} is handled elsewhere — no certificate issued here.`);
        return result;
      }

      if (result.verified && result.expiresAt) {
        if (wasVerified) {
          const patch = resolveSslPatch(domainRecord.sslStatus, result);
          if (patch) await repos.domain.updateSsl(domainRecord.id, patch);
        } else {
          await repos.domain.markVerifiedActive(domainRecord.id, {
            sslStatus: "active",
            sslIssuer: result.issuer,
            sslExpiresAt: new Date(result.expiresAt),
          });
        }
        log?.(`SSL certificate active — ${host} is Live.`);
        return result;
      }

      // Failure.
      if (wasVerified) {
        // Verified domain, transient issuance failure → keep it in the auto-heal
        // sweep (findPendingSsl covers provisioning, not error).
        const patch = resolveSslPatch(domainRecord.sslStatus, result);
        if (patch) await repos.domain.updateSsl(domainRecord.id, patch);
        log?.(`SSL for ${host} not renewed this deploy — will retry in the background.`);
      } else {
        const reason = errorReason ?? "certificate was not issued";
        await repos.domain.updateSsl(domainRecord.id, {
          sslStatus: "error",
          lastVerifyError: reason,
        });
        log?.(
          `SSL not issued for ${host} — marked Action Required (verify from the Domains tab once DNS points here). Reason: ${reason}`,
        );
      }
      return result;
    });
  };

  return {
    provisionCert,
    renewCert: async (hostname: string) => persist(hostname, await ssl.renewCert(hostname)),
    verifyCert: async (hostname: string) => persist(hostname, await ssl.verifyCert(hostname)),
    installCert: async (hostname, cert) => persist(hostname, await ssl.installCert(hostname, cert)),
  };
}

export async function ensureRouteDomainRecord(opts: {
  projectId: string;
  route: PlannedRouteDomain;
  domainByHostname: Map<string, Domain>;
}): Promise<Domain | null> {
  const { projectId, route, domainByHostname } = opts;
  const key = route.hostname.toLowerCase();

  // Cross-project hijack guard. A hostname is globally unique and owned by ONE
  // project. The service EDIT path already refuses a foreign hostname
  // (ensurePendingServiceDomain), but the DEPLOY path minted/overwrote routes via
  // findOrCreate's global lookup — which returned another project's row unchanged,
  // letting project B overwrite project A's vhost (and serve A's domain on A's
  // cert). Refuse loudly here, before any patch or create, so neither the update
  // nor the create path can claim a hostname this project doesn't own.
  const owner = await repos.domain.findByHostname(route.hostname);
  if (owner && owner.projectId !== projectId) {
    throw new ConflictError(
      `Hostname ${route.hostname} is routed by another project and cannot be claimed here.`,
    );
  }

  const existing = domainByHostname.get(key);
  // Primary (DB isPrimary) is owned by explicit setPrimary — the deploy must not
  // re-derive it from endpoint order; only a new domain may claim it, when none exists.
  const hasExistingPrimary = [...domainByHostname.values()].some((d) => d.isPrimary);
  if (existing) {
    const patch: Record<string, unknown> = {};
    const expectedDomainType = route.domainType ?? null;
    const expectedTargetPort = route.targetPort ?? null;
    const expectedTargetPath = route.targetPath ?? null;
    const expectedServiceId = route.serviceId ?? null;

    if ((existing.domainType ?? null) !== expectedDomainType) patch.domainType = expectedDomainType;
    if ((existing.targetPort ?? null) !== expectedTargetPort) patch.targetPort = expectedTargetPort;
    if ((existing.targetPath ?? null) !== expectedTargetPath) patch.targetPath = expectedTargetPath;
    if ((existing.serviceId ?? null) !== expectedServiceId) patch.serviceId = expectedServiceId;
    // isPrimary intentionally NOT patched — preserve the user's stored selection.
    // Custom domains must pass the DNS challenge — the deploy must NOT force
    // them verified/active (that's the bug that left service routes stuck with
    // no Verify option). Only host-managed (free / *.opsh.io) routes, which
    // need no challenge, auto-activate here.
    const isCustom = expectedDomainType === "custom";
    if (!isCustom) {
      if (!existing.verified) {
        patch.verified = true;
        patch.verifiedAt = new Date();
      }
      if (existing.status !== "active") patch.status = "active";
    }

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      const updated = { ...existing, ...patch } as Domain;
      domainByHostname.set(key, updated);
      return updated;
    }

    return existing;
  }

  if (!route.createIfMissing) {
    return null;
  }

  // A custom domain minted at deploy time (no prior add) starts PENDING with a
  // challenge token so the Verify pipe can run; host-managed routes go active.
  const isNewCustom = route.domainType === "custom";
  const created = await repos.domain.findOrCreate({
    projectId,
    serviceId: route.serviceId,
    hostname: route.hostname,
    targetPort: route.targetPort,
    targetPath: route.targetPath,
    domainType: route.domainType,
    isPrimary: hasExistingPrimary
      ? false
      : (route.isPrimary ?? (!route.serviceId && domainByHostname.size === 0)),
    status: isNewCustom ? "pending" : "active",
    verified: !isNewCustom,
    verifiedAt: isNewCustom ? null : new Date(),
    verificationToken: isNewCustom ? generateToken(route.hostname) : undefined,
  });
  domainByHostname.set(key, created);
  return created;
}

export function toRoutedDomainInputs(domains: PlannedRouteDomain[]): RoutedDomainInput[] {
  // A redirect is only registered when its target is one of the hostnames being
  // routed right now — see resolveRouteRedirect for why a stale target must fall
  // back to serving rather than sending every visitor to a dead host.
  const live = domains.map((domain) => domain.hostname);
  return domains.map((domain) => {
    const redirect = resolveRouteRedirect(domain, live);
    return {
      hostname: domain.hostname,
      tls: domain.tls,
      provisionSsl: domain.provisionSsl,
      terminatesTlsLocally: domain.terminatesTlsLocally,
      targetPort: domain.targetPort,
      targetPath: domain.targetPath,
      ...(redirect ? { redirectHost: redirect } : {}),
    };
  });
}
