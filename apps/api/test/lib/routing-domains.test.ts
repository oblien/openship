import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      update: vi.fn(),
      updateSsl: vi.fn(),
      markVerifiedActive: vi.fn(),
      findOrCreate: vi.fn(),
    },
  },
}));

// The per-host ACME lock talks to Postgres in prod; make it a pass-through here.
vi.mock("../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (fn: () => unknown) => fn() }),
}));

import { repos } from "@repo/db";
import {
  buildProjectRouteDomains,
  buildServiceRouteDomain,
  buildServiceRouteDomains,
  serviceCustomHostnames,
  getRoutingBaseDomain,
  createTrackedSslProvider,
  resolveRouteDestination,
  resolveServiceEndpointHostname,
} from "../../src/lib/routing-domains";

const customSvc = {
  id: "svc_web",
  name: "web",
  exposed: true,
  exposedPort: "8080",
  domainType: "custom",
  customDomain: "api.example.com",
  publicEndpoints: [],
} as any;

describe("buildProjectRouteDomains", () => {
  it("uses public endpoints as the only app routing source when they are provided", () => {
    const planned = buildProjectRouteDomains({
      project: { slug: "my-app" } as any,
      projectDomains: [{ hostname: "stale.example.com", verified: true } as any],
      managedSlug: "my-app",
      publicEndpoints: [
        { port: 3000, domain: "my-app", domainType: "free" },
        { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
      ],
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned.map((domain) => domain.hostname)).toEqual([
      `my-app.${getRoutingBaseDomain()}`,
      "admin.example.com",
    ]);
    expect(planned.find((domain) => domain.hostname === `my-app.${getRoutingBaseDomain()}`)?.targetPort).toBe(3000);
    expect(planned.find((domain) => domain.hostname === "admin.example.com")?.targetPort).toBe(4000);
  });

  it("does NOT attach the free .opsh.io fallback when an endpoint has a custom domain", () => {
    // Regression: a self-hosted deploy with a manual/custom domain was
    // still synthesizing <slug>.opsh.io as the primary route, which then
    // forced a (failing) cloud edge-proxy sync. The custom domain must be
    // the only — and primary — route.
    const planned = buildProjectRouteDomains({
      project: { slug: "girls-collage" } as any,
      projectDomains: [],
      managedSlug: "girls-collage",
      publicEndpoints: [
        { port: 3000, customDomain: "azharmedicinegirls.org", domainType: "custom" },
      ],
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned.map((domain) => domain.hostname)).toEqual(["azharmedicinegirls.org"]);
    expect(planned.some((domain) => domain.hostname.endsWith(getRoutingBaseDomain()))).toBe(false);
    expect(planned.some((domain) => domain.isCloud)).toBe(false);
    const custom = planned.find((domain) => domain.hostname === "azharmedicinegirls.org");
    expect(custom?.domainType).toBe("custom");
    expect(custom?.isPrimary).toBe(true);
    expect(custom?.requiresSslTooling).toBe(true);
    expect(custom?.provisionSsl).toBe(false);
  });

  const pendingCustomRoute = (sslStatus: string | undefined) =>
    buildProjectRouteDomains({
      project: { slug: "my-app" } as any,
      projectDomains: [
        {
          hostname: "app.example.com",
          verified: false,
          externalIngress: false,
          manualSsl: false,
          ...(sslStatus !== undefined ? { sslStatus } : {}),
        } as any,
      ],
      publicEndpoints: [{ port: 3000, customDomain: "app.example.com", domainType: "custom" }],
      runtimeName: "docker",
      usesManagedRouting: true,
    })[0];

  it("attempts SSL on the FIRST deploy of a pending custom route (sslStatus none)", () => {
    // sslStatus "none" = no issuance attempt yet, by any path. On self-hosted,
    // issuing IS the verification, so the first deploy attempts it (waited+logged)
    // instead of deferring to Verify / the 13-min cron. Tooling is prepared either way.
    expect(pendingCustomRoute("none")).toMatchObject({
      hostname: "app.example.com",
      requiresSslTooling: true,
      provisionSsl: true,
      verified: false,
    });
  });

  it("does NOT re-attempt SSL once a first attempt has already run", () => {
    // error/provisioning/active all mean "an attempt happened" — the deploy must
    // not re-fire ACME every redeploy (rate-limit loop). Tooling stays prepared;
    // the verify-pending cron / manual Verify drive any retry.
    for (const sslStatus of ["error", "provisioning", "active"]) {
      expect(pendingCustomRoute(sslStatus)).toMatchObject({
        requiresSslTooling: true,
        provisionSsl: false,
        verified: false,
      });
    }
  });

  it("does not prepare certbot for external-ingress custom routes", () => {
    const [route] = buildProjectRouteDomains({
      project: { slug: "my-app" } as any,
      projectDomains: [
        {
          hostname: "app.example.com",
          verified: false,
          externalIngress: true,
          manualSsl: false,
        } as any,
      ],
      publicEndpoints: [
        { port: 3000, customDomain: "app.example.com", domainType: "custom" },
      ],
      runtimeName: "docker",
      usesManagedRouting: true,
    });

    expect(route).toMatchObject({
      requiresSslTooling: false,
      provisionSsl: false,
      tls: false,
    });
  });

  it("still attaches the free .opsh.io fallback when there is no custom domain", () => {
    const planned = buildProjectRouteDomains({
      project: { slug: "girls-collage" } as any,
      projectDomains: [],
      managedSlug: "girls-collage",
      publicEndpoints: [
        { port: 3000, domain: "girls-collage", domainType: "free" },
      ],
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned.map((domain) => domain.hostname)).toEqual([
      `girls-collage.${getRoutingBaseDomain()}`,
    ]);
    expect(planned[0]?.isCloud).toBe(true);
  });

  it("keeps static path targets on planned routes", () => {
    const planned = buildProjectRouteDomains({
      project: { slug: "docs" } as any,
      projectDomains: [],
      managedSlug: "docs",
      publicEndpoints: [
        { targetPath: "/docs", domain: "docs", domainType: "free" },
      ],
      runtimeName: "bare",
      usesManagedRouting: true,
      // A path target is only a destination on a STATIC deploy. The single
      // production caller always states this (build-pipeline passes
      // `isStaticFileServe`); omitting it here exercised a combination that
      // cannot occur, and relied on a stale path outranking a live port.
      isStatic: true,
    });

    expect(planned).toEqual([
      expect.objectContaining({
        hostname: `docs.${getRoutingBaseDomain()}`,
        targetPath: "/docs",
        domainType: "free",
      }),
    ]);
  });

  it("routes a destination-less custom domain at the release root for a static deploy (#345)", () => {
    // The bug: a static (file-served) deploy has no port, so a Domains-tab
    // custom row carried neither targetPath nor targetPort. It was dropped as
    // "unroutable", leaving sites-enabled empty → every request hit the edge
    // default_server 404 even though the files were built. A static deploy must
    // default such a row to serving the release root.
    const planned = buildProjectRouteDomains({
      project: { slug: "portfolio" } as any,
      projectDomains: [
        { hostname: "site.example.com", domainType: "custom", verified: true } as any,
      ],
      publicEndpoints: [],
      runtimeName: "static",
      usesManagedRouting: true,
      isStatic: true,
    });

    expect(planned).toEqual([
      expect.objectContaining({
        hostname: "site.example.com",
        targetPath: "/",
        domainType: "custom",
      }),
    ]);
  });

  it("drops a destination-less custom domain for a NON-static deploy (no port/path to route)", () => {
    // Guard the fix: a port-app deploy with a destination-less row still has
    // nothing to proxy to, so it must keep being dropped — the "/" default is
    // static-only.
    const planned = buildProjectRouteDomains({
      project: { slug: "portfolio" } as any,
      projectDomains: [
        { hostname: "site.example.com", domainType: "custom", verified: true } as any,
      ],
      publicEndpoints: [],
      runtimeName: "docker",
      usesManagedRouting: true,
    });

    expect(planned).toEqual([]);
  });

  it("still routes a Domains-tab custom row alongside configured endpoints on a static deploy (#345)", () => {
    // Even when a static deploy DOES have public endpoints, a custom domain row
    // added later via the Domains tab never appears in publicEndpoints — so the
    // static path must fall through to the project's own domain rows too (the
    // `seen` set dedups anything already routed above).
    const planned = buildProjectRouteDomains({
      project: { slug: "portfolio" } as any,
      projectDomains: [
        { hostname: "extra.example.com", domainType: "custom", verified: true } as any,
      ],
      managedSlug: "portfolio",
      publicEndpoints: [{ targetPath: "/", domain: "portfolio", domainType: "free" }],
      runtimeName: "static",
      usesManagedRouting: true,
      isStatic: true,
    });

    const hostnames = planned.map((domain) => domain.hostname);
    expect(hostnames).toContain(`portfolio.${getRoutingBaseDomain()}`);
    expect(hostnames).toContain("extra.example.com");
    expect(planned.find((domain) => domain.hostname === "extra.example.com")?.targetPath).toBe("/");
  });

  it("keeps service route target ports on the planned route", () => {
    const planned = buildServiceRouteDomain({
      project: { slug: "my-app", name: "My App" } as any,
      service: {
        id: "svc_web",
        name: "web",
        exposed: true,
        exposedPort: "8080",
        customDomain: "api.example.com",
        domainType: "custom",
      } as any,
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned?.hostname).toBe("api.example.com");
    expect(planned?.targetPort).toBe(8080);
    expect(planned?.domainType).toBe("custom");
  });
});

describe("buildServiceRouteDomains — custom-domain SSL gate", () => {
  const project = { slug: "my-app", name: "My App" } as any;

  it("does NOT provision SSL for a custom domain with no verified row (pending)", () => {
    // No domain map → row unknown → treated as unverified → no certbot attempt.
    const [route] = buildServiceRouteDomains({
      project,
      service: customSvc,
      runtimeName: "bare",
      usesManagedRouting: true,
    });
    expect(route?.hostname).toBe("api.example.com");
    expect(route?.domainType).toBe("custom");
    expect(route?.requiresSslTooling).toBe(true);
    expect(route?.provisionSsl).toBe(false);
    expect(route?.verified).toBe(false);
  });

  it("provisions SSL only once the custom domain row is verified", () => {
    const domainByHostname = new Map<string, any>([
      ["api.example.com", { hostname: "api.example.com", verified: true }],
    ]);
    const [route] = buildServiceRouteDomains({
      project,
      service: customSvc,
      runtimeName: "bare",
      usesManagedRouting: true,
      domainByHostname,
    });
    expect(route?.requiresSslTooling).toBe(true);
    expect(route?.provisionSsl).toBe(true);
    expect(route?.verified).toBe(true);
  });

  it("canonicalizes a scheme/slash-dressed custom domain to the stored host", () => {
    const [route] = buildServiceRouteDomains({
      project,
      service: { ...customSvc, customDomain: "HTTPS://Api.Example.com/" },
      runtimeName: "bare",
      usesManagedRouting: true,
    });
    // Matches the normalized row key so verify/SSL/register all agree.
    expect(route?.hostname).toBe("api.example.com");
  });
});

describe("resolveRouteDestination", () => {
  // Pins the caveats the dedup audit flagged as load-bearing when this ternary
  // was collapsed out of buildProjectRouteDomains' two loops.
  it("prefers an explicit path over a port ON A STATIC DEPLOY", () => {
    expect(resolveRouteDestination({ targetPath: "/api", targetPort: 3000 }, true)).toEqual({
      targetPath: "/api",
    });
  });

  /**
   * THE REGRESSION THAT SHIPPED. `domain.targetPath` is persisted, so a hostname
   * that once served a static subpath keeps it forever. When a port-based app was
   * later deployed to that same hostname, the row carried BOTH — violating the
   * "exactly one of port / targetPath" invariant — and this function used to test
   * `targetPath` first and unconditionally, so the stale path won.
   *
   * The consequence was not a partial vhost: `registerRoute` overwrote the file
   * completely and correctly, as STATIC. Redeploying a Next.js server app onto a
   * hostname that had once served static files brought the OLD static site back,
   * while the new container ran healthy and the deploy reported green.
   *
   * It was self-healing in the wrong direction too: the plan derived `targetPath`
   * from the row and the reconcile wrote the plan back to the row, so
   * `expected === existing` and the stale column could never be cleared.
   */
  it("ignores a stale path and uses the live port on a NON-static deploy", () => {
    expect(resolveRouteDestination({ targetPath: "/api", targetPort: 3000 }, false)).toEqual({
      targetPort: 3000,
    });
  });

  it("treats an unstated deploy shape as non-static — a dropped route is visible, wrong content is not", () => {
    // Production always states it. If a future caller forgets, failing toward "no
    // destination" surfaces as an unrouted domain; failing toward the stored path
    // would silently serve a previous project's files.
    expect(resolveRouteDestination({ targetPath: "/api", targetPort: 3000 })).toEqual({
      targetPort: 3000,
    });
  });

  it("a non-static deploy with ONLY a stale path has no destination at all", () => {
    // Nothing to proxy to and files are not what this deploy serves — better an
    // unrouted domain the operator can see than the old static site coming back.
    expect(resolveRouteDestination({ targetPath: "/docs" }, false)).toBeUndefined();
  });

  it("uses an explicit port when there is no path", () => {
    expect(resolveRouteDestination({ targetPort: 8080 })).toEqual({ targetPort: 8080 });
  });

  it("treats a NULL port (portless nullable DB row) as absent — never {targetPort: null}", () => {
    // The whole reason the check is `!= null` not `!== undefined`: a null here
    // must NOT produce a route with a broken upstream.
    expect(resolveRouteDestination({ targetPort: null })).toBeUndefined();
  });

  it("keeps port 0 as an explicit port (not falsy-dropped)", () => {
    expect(resolveRouteDestination({ targetPort: 0 })).toEqual({ targetPort: 0 });
  });

  it("lets an empty-string path fall through to the port branch", () => {
    expect(resolveRouteDestination({ targetPath: "", targetPort: 5000 })).toEqual({
      targetPort: 5000,
    });
  });

  it("falls back to the release root only for a static deploy", () => {
    expect(resolveRouteDestination({}, true)).toEqual({ targetPath: "/" });
    expect(resolveRouteDestination({})).toBeUndefined();
    expect(resolveRouteDestination({ targetPort: null }, true)).toEqual({ targetPath: "/" });
  });
});

describe("resolveServiceEndpointHostname", () => {
  const project = { slug: "my-app", name: "My App" } as any;
  const service = { name: "web", kind: "compose" } as any;

  it("normalizes a custom endpoint's domain", () => {
    expect(
      resolveServiceEndpointHostname(
        project,
        service,
        { domainType: "custom", customDomain: "HTTPS://Api.Example.com/" },
        true,
      ),
    ).toBe("api.example.com");
  });

  it("returns null for a custom endpoint with no customDomain — even when managed routing is on (terminal branch, must NOT fall through to a free hostname)", () => {
    expect(
      resolveServiceEndpointHostname(project, service, { domainType: "custom" }, true),
    ).toBeNull();
  });

  it("builds a managed <label>.<baseDomain> host for a free endpoint under managed routing", () => {
    expect(
      resolveServiceEndpointHostname(project, service, { domainType: "free", domain: "web" }, true),
    ).toBe(`web.${getRoutingBaseDomain()}`);
  });

  it("returns null for a free endpoint when the box does not do managed routing", () => {
    expect(
      resolveServiceEndpointHostname(project, service, { domainType: "free", domain: "web" }, false),
    ).toBeNull();
  });
});

describe("serviceCustomHostnames", () => {
  it("returns configured custom hostnames regardless of exposed state", () => {
    expect(serviceCustomHostnames(customSvc)).toEqual(["api.example.com"]);
    // Unexposed but still configured → hostname is still reported (drives the
    // config-based domain-row lifecycle, not routing state).
    expect(serviceCustomHostnames({ ...customSvc, exposed: false })).toEqual(["api.example.com"]);
  });

  it("is empty for a free/host-managed service", () => {
    expect(
      serviceCustomHostnames({ ...customSvc, domainType: "free", customDomain: null, domain: "web" } as any),
    ).toEqual([]);
  });
});

describe("createTrackedSslProvider (deploy-time issuance)", () => {
  beforeEach(() => vi.clearAllMocks());

  const sslWith = (result: any, opts: { throws?: string } = {}) =>
    ({
      provisionCert: vi.fn(async () => {
        if (opts.throws) throw new Error(opts.throws);
        return result;
      }),
      renewCert: vi.fn(),
      verifyCert: vi.fn(),
      installCert: vi.fn(),
    }) as any;

  const mapWith = (row: any) => new Map([["app.example.com", row]]) as any;

  it("marks an unverified domain verified+active on a successful first issuance", async () => {
    const ssl = sslWith({
      domain: "app.example.com",
      verified: true,
      expiresAt: "2026-01-01T00:00:00.000Z",
      issuer: "Let's Encrypt",
    });
    const tracked = createTrackedSslProvider(
      ssl,
      mapWith({ id: "dom_1", verified: false, sslStatus: "none" }),
    );
    const r = await tracked.provisionCert("app.example.com");
    expect(r.verified).toBe(true);
    expect(repos.domain.markVerifiedActive).toHaveBeenCalledWith(
      "dom_1",
      expect.objectContaining({ sslStatus: "active", sslIssuer: "Let's Encrypt" }),
    );
    // No promote (never steal an existing primary) and no error write on success.
    expect((repos.domain.markVerifiedActive as any).mock.calls[0][1].promote).toBeUndefined();
    expect(repos.domain.updateSsl).not.toHaveBeenCalled();
  });

  it("marks Action Required (sslStatus=error + reason) when a first attempt fails", async () => {
    const ssl = sslWith(null, { throws: "DNS is not pointing here yet" });
    const tracked = createTrackedSslProvider(
      ssl,
      mapWith({ id: "dom_1", verified: false, sslStatus: "none" }),
    );
    const r = await tracked.provisionCert("app.example.com");
    expect(r.verified).toBe(false);
    expect(repos.domain.updateSsl).toHaveBeenCalledWith(
      "dom_1",
      expect.objectContaining({
        sslStatus: "error",
        lastVerifyError: expect.stringContaining("DNS is not pointing here"),
      }),
    );
    expect(repos.domain.markVerifiedActive).not.toHaveBeenCalled();
  });

  it("keeps a VERIFIED domain's failed renewal at provisioning (auto-heal sweep), never error", async () => {
    const ssl = sslWith({
      domain: "app.example.com",
      verified: false,
      expiresAt: "",
      issuer: "",
      reason: "missing",
    });
    const tracked = createTrackedSslProvider(
      ssl,
      mapWith({ id: "dom_1", verified: true, sslStatus: "active" }),
    );
    await tracked.provisionCert("app.example.com");
    expect(repos.domain.updateSsl).toHaveBeenCalledWith(
      "dom_1",
      expect.objectContaining({ sslStatus: "provisioning" }),
    );
    // Must NOT drop a verified row out of the findPendingSsl sweep by writing error.
    const wroteError = (repos.domain.updateSsl as any).mock.calls.some(
      ([, patch]: [string, any]) => patch.sslStatus === "error",
    );
    expect(wroteError).toBe(false);
  });

  it("writes nothing when TLS is handled elsewhere (not_local)", async () => {
    const ssl = sslWith({
      domain: "app.example.com",
      verified: true,
      expiresAt: "",
      issuer: "",
      reason: "not_local",
    });
    const tracked = createTrackedSslProvider(
      ssl,
      mapWith({ id: "dom_1", verified: false, sslStatus: "none" }),
    );
    await tracked.provisionCert("app.example.com");
    expect(repos.domain.updateSsl).not.toHaveBeenCalled();
    expect(repos.domain.markVerifiedActive).not.toHaveBeenCalled();
  });
});
