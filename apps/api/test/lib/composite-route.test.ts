import { describe, expect, it } from "vitest";

import {
  planCompositeRoute,
  deriveBackendPrefix,
  buildCompositeProxyLocations,
  buildCompositeRegistration,
} from "../../src/modules/deployments/compose/composite-route";

const web = { id: "web", name: "web", kind: "monorepo", framework: "vite", startCommand: "", enabled: true };
const api = { id: "api", name: "api", kind: "monorepo", framework: "express", startCommand: "npm start", enabled: true };

describe("deriveBackendPrefix", () => {
  it("takes the literal prefix of the first non-SPA rewrite", () => {
    expect(
      deriveBackendPrefix([
        { source: "/api/(.*)", destination: "/api/index.js" },
        { source: "/(.*)", destination: "/index.html" },
      ]),
    ).toBe("/api/");
  });

  it("handles :param style sources", () => {
    expect(deriveBackendPrefix([{ source: "/backend/:path*", destination: "/backend" }])).toBe("/backend/");
  });

  it("returns null when only an SPA fallback exists", () => {
    expect(deriveBackendPrefix([{ source: "/(.*)", destination: "/index.html" }])).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(deriveBackendPrefix(undefined)).toBeNull();
  });
});

describe("planCompositeRoute", () => {
  it("composes exactly one static frontend + one server backend", () => {
    const plan = planCompositeRoute([web, api]);
    expect(plan).toEqual({ frontendServiceId: "web", backendServiceId: "api", backendPathPrefix: "/api/" });
  });

  it("uses the rewrite-derived prefix when provided", () => {
    const plan = planCompositeRoute([web, api], {
      rewrites: [
        { source: "/backend/(.*)", destination: "/backend/index.js" },
        { source: "/(.*)", destination: "/index.html" },
      ],
    });
    expect(plan?.backendPathPrefix).toBe("/backend/");
  });

  it("does NOT compose with two static apps", () => {
    const web2 = { ...web, id: "docs", name: "docs" };
    expect(planCompositeRoute([web, web2])).toBeNull();
  });

  it("does NOT compose with no server app", () => {
    expect(planCompositeRoute([web])).toBeNull();
  });

  it("does NOT compose when the server app is disabled", () => {
    expect(planCompositeRoute([web, { ...api, enabled: false }])).toBeNull();
  });
});

describe("buildCompositeProxyLocations", () => {
  it("maps the backend to its prefix", () => {
    const plan = planCompositeRoute([web, api])!;
    expect(buildCompositeProxyLocations(plan, "http://10.0.0.5:3000")).toEqual([
      { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
    ]);
  });
});

describe("buildCompositeRegistration", () => {
  const targets: Record<string, string> = {
    web: "http://10.0.0.4:8080",
    api: "http://10.0.0.5:3000",
  };
  const resolveTargetUrl = (id: string) => targets[id] ?? null;
  const resolveDomain = (id: string) =>
    id === "web" ? { hostname: "app.opsh.io", isCustomDomain: false } : null;

  it("builds a single-domain register: frontend at /, backend at /api (default)", () => {
    const out = buildCompositeRegistration({ services: [web, api], resolveTargetUrl, resolveDomain });
    expect(out).not.toBeNull();
    expect(out!.register.hostname).toBe("app.opsh.io");
    expect(out!.register.targetUrl).toBe("http://10.0.0.4:8080");
    expect(out!.register.proxyLocations).toEqual([
      { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
    ]);
  });

  it("uses the repo's vercel.json rewrites + compiles redirects/headers", () => {
    const out = buildCompositeRegistration({
      services: [web, api],
      routingConfig: {
        rewrites: [
          { source: "/backend/(.*)", destination: "/backend/index.js" },
          { source: "/(.*)", destination: "/index.html" },
        ],
        redirects: [{ source: "/old", destination: "/new", permanent: true }],
        headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      },
      resolveTargetUrl,
      resolveDomain,
    });
    expect(out!.register.proxyLocations).toEqual([
      { pathPrefix: "/backend/", targetUrl: "http://10.0.0.5:3000" },
    ]);
    expect(out!.register.redirects).toEqual([
      { path: "/old", exact: true, statusCode: 308, destination: "/new" },
    ]);
    expect(out!.register.headerRules).toEqual([
      { path: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
    ]);
  });

  it("returns null when an upstream can't be resolved (best-effort)", () => {
    const out = buildCompositeRegistration({
      services: [web, api],
      resolveTargetUrl: (id) => (id === "web" ? null : targets[id]),
      resolveDomain,
    });
    expect(out).toBeNull();
  });

  it("returns null when the repo isn't a composite", () => {
    expect(
      buildCompositeRegistration({ services: [web], resolveTargetUrl, resolveDomain }),
    ).toBeNull();
  });
});

describe("buildCompositeRegistration — static frontend served from disk", () => {
  const domain = { hostname: "app.example.com", isCustomDomain: true };
  const targets: Record<string, string> = { api: "http://10.0.0.5:3000" };

  it("serves the frontend from a host dir and still proxies the backend at /api/", () => {
    const reg = buildCompositeRegistration({
      services: [web, api],
      resolveTargetUrl: (id) => targets[id] ?? null,
      resolveDomain: () => domain,
      resolveStaticRoot: (id) => (id === "web" ? "/opt/openship/static/proj/web" : null),
    });
    // One vhost: files at `/`, backend proxied at the prefix. No frontend upstream,
    // so no container and no port for the static app.
    expect(reg?.register.staticRoot).toBe("/opt/openship/static/proj/web");
    expect(reg?.register.targetUrl).toBeUndefined();
    expect(reg?.register.proxyLocations).toEqual([
      { pathPrefix: "/api/", targetUrl: "http://10.0.0.5:3000" },
    ]);
  });

  it("does NOT require a frontend upstream when a static root is given", () => {
    // The whole point: a static frontend has no port. Resolving an upstream for it
    // would fail the composite and silently drop back to per-service routing.
    const reg = buildCompositeRegistration({
      services: [web, api],
      resolveTargetUrl: (id) => (id === "api" ? targets.api : null),
      resolveDomain: () => domain,
      resolveStaticRoot: (id) => (id === "web" ? "/opt/openship/static/proj/web" : null),
    });
    expect(reg).not.toBeNull();
  });

  it("falls back to a frontend upstream when no static root resolves (cloud)", () => {
    // Oblien runs the workload; there is no host dir to serve, so the frontend
    // stays a proxied container exactly as before.
    const reg = buildCompositeRegistration({
      services: [web, api],
      resolveTargetUrl: (id) => ({ web: "http://10.0.0.4:8080", api: targets.api })[id] ?? null,
      resolveDomain: () => domain,
      resolveStaticRoot: () => null,
    });
    expect(reg?.register.targetUrl).toBe("http://10.0.0.4:8080");
    expect(reg?.register.staticRoot).toBeUndefined();
  });

  it("still needs the backend upstream — a static root alone is not a composite", () => {
    const reg = buildCompositeRegistration({
      services: [web, api],
      resolveTargetUrl: () => null,
      resolveDomain: () => domain,
      resolveStaticRoot: (id) => (id === "web" ? "/opt/openship/static/proj/web" : null),
    });
    expect(reg).toBeNull();
  });
});
