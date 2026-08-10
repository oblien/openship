import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      update: vi.fn(),
      updateSsl: vi.fn(),
      findOrCreate: vi.fn(),
    },
  },
}));

import {
  mergeServiceRoutingPatch,
  pickCanonicalDomainRow,
  resolveProjectAccess,
  resolveStoredPublicEndpoints,
  syncStoredPublicEndpoints,
  type ProjectDomainRow,
  type StoredServiceRouting,
} from "../../src/lib/public-endpoints";
import { getRoutingBaseDomain } from "../../src/lib/routing-domains";

// Build a domain row with only the fields the access resolver reads; the rest
// of ProjectDomainRow is irrelevant here, so cast rather than fill every column.
const row = (r: Partial<ProjectDomainRow>): ProjectDomainRow =>
  ({ verified: false, isPrimary: false, serviceId: null, domainType: "custom", ...r }) as ProjectDomainRow;

describe("public endpoint helpers", () => {
  it("uses the primary project custom domain when an explicit route target is provided", () => {
    const endpoints = resolveStoredPublicEndpoints({
      targetPath: "/",
      projectDomains: [{
        hostname: "app.example.com",
        isPrimary: true,
        verified: true,
        serviceId: null,
      } as any],
    });

    expect(endpoints).toEqual([{
      customDomain: "app.example.com",
      targetPath: "/",
      domainType: "custom",
    }]);
  });

  it("syncs the primary endpoint slug while preserving secondary endpoints", () => {
    const routing = syncStoredPublicEndpoints({
      current: [
        { port: 3000, domain: "my-app", domainType: "free" },
        { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
      ],
      slug: "renamed-app",
    });

    expect(routing.slug).toBe("renamed-app");
    expect(routing.publicEndpoints).toEqual([
      { port: 3000, domain: "renamed-app", domainType: "free" },
      { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
    ]);
  });

  it("prefers persisted route rows over legacy stored endpoints", () => {
    const endpoints = resolveStoredPublicEndpoints({
      stored: [{ port: 3000, domain: "legacy-app", domainType: "free" }],
      slug: "my-app",
      projectDomains: [
        {
          hostname: `my-app.${getRoutingBaseDomain()}`,
          isPrimary: true,
          verified: true,
          serviceId: null,
          targetPort: 3100,
          domainType: "free",
        },
        {
          hostname: "admin.example.com",
          isPrimary: false,
          verified: true,
          serviceId: null,
          targetPort: 4000,
          domainType: "custom",
        },
      ] as any,
    });

    expect(endpoints).toEqual([
      { port: 3100, domain: "my-app", domainType: "free" },
      { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
    ]);
  });

  it("requires an explicit route destination for default managed routes", () => {
    const endpoints = resolveStoredPublicEndpoints({
      slug: "my-app",
    });

    expect(endpoints).toEqual([]);
  });

  it("creates a default managed route when a target path is provided", () => {
    const endpoints = resolveStoredPublicEndpoints({
      slug: "my-app",
      targetPath: "/docs",
    });

    expect(endpoints).toEqual([
      { domain: "my-app", targetPath: "/docs", domainType: "free" },
    ]);
  });

  it("keeps an explicit free port endpoint by falling back to the project slug", () => {
    const routing = syncStoredPublicEndpoints({
      next: [{ port: 3200, domainType: "free" }],
      slug: "my-app",
    });

    expect(routing.slug).toBe("my-app");
    expect(routing.publicEndpoints).toEqual([
      { port: 3200, domain: "my-app", domainType: "free" },
    ]);
  });
});

/**
 * A scalar routing patch (`{ domainType, customDomain }`) describes ONE route,
 * while `publicEndpoints` holds the whole set — and the DB normalizer lets a
 * non-empty array win outright. So the scalars have to be folded INTO the set
 * before that point: shadowing them dropped the user's chosen domain (and made
 * the free-domain cloud gate judge the stored primary instead), while collapsing
 * to them would delete the sibling routes "Add route" had just created.
 */
describe("mergeServiceRoutingPatch", () => {
  const multiRoute: StoredServiceRouting = {
    exposed: true,
    exposedPort: "3210",
    ports: ["3210:3210", "3211:3211"],
    domain: "convex-backend",
    customDomain: null,
    domainType: "free",
    publicEndpoints: [
      { port: 3210, domainType: "free", domain: "convex-backend" },
      { port: 3211, domainType: "free", domain: "convex-backend-http" },
    ],
  } as StoredServiceRouting;

  it("applies a scalar custom-domain patch to the primary and keeps siblings", () => {
    const next = mergeServiceRoutingPatch({
      patch: { domainType: "custom", customDomain: "api.example.com" },
      stored: multiRoute,
    });

    expect(next.domainType).toBe("custom");
    expect(next.customDomain).toBe("api.example.com");
    expect(next.domain).toBeNull();
    expect(next.publicEndpoints).toEqual([
      { port: 3210, domainType: "custom", customDomain: "api.example.com" },
      { port: 3211, domainType: "free", domain: "convex-backend-http" },
    ]);
  });

  it("adds a route on a new port instead of replacing the existing one", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposed: true, exposedPort: "4000", domainType: "free", domain: "admin" },
      stored: multiRoute,
    });

    expect(next.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "convex-backend" },
      { port: 3211, domainType: "free", domain: "convex-backend-http" },
      { port: 4000, domainType: "free", domain: "admin" },
    ]);
  });

  it("adds a second route to a single-route (scalar-only) service", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposed: true, exposedPort: "9090", domainType: "free", domain: "metrics" },
      stored: {
        exposed: true,
        exposedPort: "8080",
        ports: ["8080:8080"],
        domain: "web",
        customDomain: null,
        domainType: "free",
        publicEndpoints: [],
      } as StoredServiceRouting,
    });

    expect(next.publicEndpoints).toEqual([
      { port: 8080, domainType: "free", domain: "web" },
      { port: 9090, domainType: "free", domain: "metrics" },
    ]);
  });

  it("MOVES a route when only the port changes (one hostname, one port)", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposedPort: "3300" },
      stored: multiRoute,
    });

    expect(next.publicEndpoints).toEqual([
      { port: 3300, domainType: "free", domain: "convex-backend" },
      { port: 3211, domainType: "free", domain: "convex-backend-http" },
    ]);
  });

  it("keys the upsert off the first container port when no port is stored or sent", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposed: true, domainType: "custom", customDomain: "web.example.com" },
      stored: {
        exposed: false,
        exposedPort: null,
        ports: ["8080:80"],
        domain: null,
        customDomain: null,
        domainType: "free",
        publicEndpoints: [{ port: 3000, domainType: "free", domain: "other" }],
      } as StoredServiceRouting,
    });

    // Stored primary's port (3000) outranks the port derived from `ports`, and a
    // single route lives in the scalars — so the port has to be pinned there or
    // the route would silently move to the derived 80.
    expect(next.publicEndpoints).toEqual([]);
    expect(next.exposedPort).toBe("3000");
    expect(next.customDomain).toBe("web.example.com");
  });

  it("pauses routing on an explicit exposed:false, keeping the route config", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposed: false },
      stored: multiRoute,
    });

    // `exposed` is a GATE and nothing else: it decides whether the set is served,
    // never what the set is. Clearing it here is what emptied the route set on a
    // plain toggle, de-registering the live vhosts — and re-exposing then came
    // back with no routes at all.
    expect(next.exposed).toBe(false);
    expect(next.publicEndpoints).toEqual(multiRoute.publicEndpoints);
    expect(next.exposedPort).toBe(multiRoute.exposedPort);
    expect(next.domain).toBe(multiRoute.domain);
    expect(next.domainType).toBe(multiRoute.domainType);
  });

  it("lets an explicit publicEndpoints array win outright", () => {
    const next = mergeServiceRoutingPatch({
      patch: { publicEndpoints: [{ port: 5000, domainType: "free", domain: "only" }] },
      stored: multiRoute,
    });

    expect(next.publicEndpoints).toEqual([{ port: 5000, domainType: "free", domain: "only" }]);
  });

  it("clears the extra routes on an explicit empty array", () => {
    const next = mergeServiceRoutingPatch({
      patch: { publicEndpoints: [] },
      stored: multiRoute,
    });

    expect(next.publicEndpoints).toEqual([]);
    expect(next.domain).toBe("convex-backend");
  });

  it("keeps a single route in the scalar columns (create / single-route edit)", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposed: true, exposedPort: "8080", domainType: "free", domain: "web" },
      stored: null,
    });

    expect(next).toEqual({
      exposed: true,
      exposedPort: "8080",
      domain: "web",
      customDomain: null,
      domainType: "free",
      publicEndpoints: [],
    });
  });

  it("leaves the scalars alone when nothing routable can be keyed", () => {
    const next = mergeServiceRoutingPatch({
      patch: { exposed: true, domainType: "free", domain: "web" },
      stored: null,
    });

    expect(next.exposedPort).toBeNull();
    expect(next.domain).toBe("web");
    expect(next.publicEndpoints).toEqual([]);
  });
});

describe("pickCanonicalDomainRow", () => {
  it("prefers a verified primary over a verified non-primary", () => {
    const picked = pickCanonicalDomainRow([
      row({ hostname: "a.example.com", verified: true, isPrimary: false }),
      row({ hostname: "b.example.com", verified: true, isPrimary: true }),
    ]);
    expect(picked?.hostname).toBe("b.example.com");
  });

  it("falls back to the first verified row when none is primary", () => {
    const picked = pickCanonicalDomainRow([
      row({ hostname: "a.example.com", verified: true, isPrimary: false }),
      row({ hostname: "b.example.com", verified: true, isPrimary: false }),
    ]);
    expect(picked?.hostname).toBe("a.example.com");
  });

  it("excludes unverified rows even when one is primary", () => {
    expect(
      pickCanonicalDomainRow([row({ hostname: "pending.example.com", verified: false, isPrimary: true })]),
    ).toBeNull();
  });

  it("returns null for empty / null / undefined", () => {
    expect(pickCanonicalDomainRow([])).toBeNull();
    expect(pickCanonicalDomainRow(null)).toBeNull();
    expect(pickCanonicalDomainRow(undefined)).toBeNull();
  });
});

describe("resolveProjectAccess", () => {
  it("resolves a project whose only domains are service-scoped (the openship repro)", () => {
    // Multi-service project: both verified custom domains live on service-scoped
    // rows, so project-level publicEndpoints is empty — the exact case that used
    // to fall back to localhost. Access must be the primary service host.
    const access = resolveProjectAccess({
      rows: [
        row({ hostname: "api.openship.io", serviceId: "svc_api", verified: true, isPrimary: true }),
        row({ hostname: "app.openship.io", serviceId: "svc_dash", verified: true, isPrimary: false }),
      ],
      target: "server",
      port: null,
    });
    expect(access).toEqual({
      url: "https://api.openship.io",
      host: "api.openship.io",
      kind: "custom",
      isLocal: false,
      urls: ["https://api.openship.io", "https://app.openship.io"],
    });
  });

  it("lets a verified primary win over a non-primary row", () => {
    const access = resolveProjectAccess({
      rows: [
        row({ hostname: "svc.example.com", serviceId: "svc_1", verified: true, isPrimary: false }),
        row({ hostname: "app.example.com", serviceId: null, verified: true, isPrimary: true }),
      ],
      target: "server",
      port: null,
    });
    expect(access.host).toBe("app.example.com");
    expect(access.url).toBe("https://app.example.com");
    expect(access.urls).toEqual(["https://app.example.com", "https://svc.example.com"]);
  });

  it("classifies a managed free subdomain as kind 'free'", () => {
    const base = getRoutingBaseDomain();
    const access = resolveProjectAccess({
      rows: [row({ hostname: `myapp.${base}`, verified: true, isPrimary: true, domainType: "free" })],
      target: "server",
      port: null,
    });
    expect(access.kind).toBe("free");
    expect(access.host).toBe(`myapp.${base}`);
  });

  it("dedupes urls and drops unverified rows, primary first", () => {
    const access = resolveProjectAccess({
      rows: [
        row({ hostname: "one.example.com", verified: true, isPrimary: true }),
        row({ hostname: "one.example.com", verified: true, isPrimary: false }),
        row({ hostname: "two.example.com", verified: true, isPrimary: false }),
        row({ hostname: "unverified.example.com", verified: false, isPrimary: false }),
      ],
      target: "server",
      port: null,
    });
    expect(access.urls).toEqual(["https://one.example.com", "https://two.example.com"]);
  });

  it("reads localhost:port for a local project with no domain", () => {
    expect(resolveProjectAccess({ rows: [], target: "local", port: 8080 })).toEqual({
      url: "http://localhost:8080",
      host: "localhost:8080",
      kind: "local",
      isLocal: true,
      urls: [],
    });
  });

  it("defaults the local port to 3000 when unset", () => {
    expect(resolveProjectAccess({ rows: null, target: "local", port: null }).host).toBe("localhost:3000");
  });

  it("reads 'none' (never localhost) for a server/cloud project with no domain", () => {
    const none = { url: null, host: null, kind: "none", isLocal: false, urls: [] };
    expect(resolveProjectAccess({ rows: [], target: "server", port: 3000 })).toEqual(none);
    expect(resolveProjectAccess({ rows: [], target: "cloud", port: null })).toEqual(none);
  });

  it("ignores an unverified primary domain (target decides instead)", () => {
    const access = resolveProjectAccess({
      rows: [row({ hostname: "pending.example.com", verified: false, isPrimary: true })],
      target: "server",
      port: null,
    });
    expect(access.kind).toBe("none");
    expect(access.host).toBeNull();
  });
});