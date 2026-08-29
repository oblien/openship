import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listByProject,
  findDeployment,
  resolveRuntime,
  reconcile,
  syncManagedEdge,
  deregisterManagedEdge,
  listServicesByProject,
  listServicesByDeployment,
} = vi.hoisted(() => ({
  listByProject: vi.fn(),
  findDeployment: vi.fn(),
  resolveRuntime: vi.fn(),
  reconcile: vi.fn(),
  syncManagedEdge: vi.fn(),
  deregisterManagedEdge: vi.fn(),
  listServicesByProject: vi.fn(),
  listServicesByDeployment: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: { listByProject },
    deployment: { findById: findDeployment },
    // A multi-service release resolves a project-level route's upstream from the
    // SERVICE that owns its port, so the re-apply reads both service tables.
    // Default: no services → the single-app (deployment.containerId) path.
    service: { listByProject: listServicesByProject, listByDeployment: listServicesByDeployment },
  },
}));

// Only the runtime resolution is faked. `resolveDeploymentStaticRoot` is pure and
// is THE shared answer for "where does this deployment serve files from" (the live
// vhost and the output probe both call it) — stubbing it here would let the two
// drift silently, which is the thing sharing it prevents.
// Adapts the flat `resolveRuntime` stub to the platform shape the re-apply now
// resolves (and releases): `{ platform: { routing, runtime }, effectiveTarget, serverId }`.
vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/deployment-runtime")>()),
  disposePlatform: () => {},
  resolveDeploymentPlatform: async (...args: unknown[]) => {
    const flat = (await resolveRuntime(...args)) as Record<string, unknown>;
    return { platform: flat, effectiveTarget: flat.effectiveTarget, serverId: flat.serverId };
  },
}));

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: reconcile,
}));

vi.mock("../../../src/modules/route-rules/route-rule.service", () => ({
  pushProjectRules: vi.fn().mockResolvedValue(undefined),
}));

// The managed-edge sync is awaited inside the re-apply; mocked so no test reaches
// the network and so the "which domains got synced" half is assertable.
vi.mock("../../../src/lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes: syncManagedEdge,
  deregisterManagedEdgeRoutes: deregisterManagedEdge,
}));

import {
  deriveEnvironmentPublicEndpoints,
  deriveNextProjectRouteState,
  reapplyProjectLiveRoutes,
  shouldRefuseLoopbackRoute,
} from "../../../src/modules/domains/project-route.service";

// Default for every suite below: the project has NO services, so a project-level
// route resolves against `deployment.containerId` (the single-app path). The
// multi-service suite overrides these.
beforeEach(() => {
  listServicesByDeployment.mockReset().mockResolvedValue([]);
  listServicesByProject.mockReset().mockResolvedValue([]);
  syncManagedEdge.mockReset().mockResolvedValue({ failures: [] });
  deregisterManagedEdge.mockReset().mockResolvedValue({ failures: [] });
});

describe("shouldRefuseLoopbackRoute", () => {
  it("refuses a tenant project's public route to the dashboard port on loopback", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 3001, { isSelfApp: false })).toBe(true);
  });

  it("refuses a tenant project's public route to the admin API port on loopback", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 4000, { isSelfApp: false })).toBe(true);
  });

  it("allows the self-app's own public route to the dashboard port on loopback", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 3001, { isSelfApp: true })).toBe(false);
  });

  it("allows a non-reserved port on loopback regardless of self-app status", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 8080, { isSelfApp: false })).toBe(false);
  });

  it("allows any port on a non-loopback host (container IP)", () => {
    expect(shouldRefuseLoopbackRoute("172.17.0.5", 3001, { isSelfApp: false })).toBe(false);
  });
});

describe("deriveEnvironmentPublicEndpoints", () => {
  it("clones an explicit proxy target without inventing a fallback port", () => {
    expect(deriveEnvironmentPublicEndpoints([{ port: 4010 }], "preview-app")).toEqual([
      { port: 4010, domain: "preview-app", domainType: "free" },
    ]);
  });

  it("clones an explicit static path target without inventing a port", () => {
    expect(deriveEnvironmentPublicEndpoints([{ targetPath: "/docs" }], "preview-docs")).toEqual([
      { targetPath: "/docs", domain: "preview-docs", domainType: "free" },
    ]);
  });

  it("returns no endpoints when the base project has no explicit destination", () => {
    expect(deriveEnvironmentPublicEndpoints([], "preview-app")).toEqual([]);
  });
});

// Behavioral regression for issue #129: the self-app's own boot route to its
// dashboard port on loopback was refused, so OpenResty never bound 443 and the
// domain was unreachable. Drives the ACTUAL failing branch (bare adopt runtime,
// resolveTargetUrl) rather than just the shouldRefuseLoopbackRoute predicate.
describe("reapplyProjectLiveRoutes self-app loopback route (issue #129)", () => {
  // Mirrors the real self-app adopt deployment: meta { runtimeMode: "bare" } →
  // the app runs on the host, so the runtime resolves the upstream to
  // 127.0.0.1:<dashboard port> rather than a container IP.
  const project = {
    id: "proj-openship",
    slug: "openship",
    port: 3001,
    cloudWorkspaceId: null,
    activeDeploymentId: "dep-1",
    organizationId: "org-1",
    webhookDomain: null,
  };

  beforeEach(() => {
    reconcile.mockReset().mockResolvedValue(undefined);
    resolveRuntime.mockReset();
    findDeployment.mockReset();
    listByProject.mockReset();

    // One public hostname → the dashboard port, no static path.
    listByProject.mockResolvedValue([
      {
        id: "dom-1",
        hostname: "panel.example.com",
        isPrimary: true,
        serviceId: null,
        targetPort: 3001,
        targetPath: null,
        domainType: "free",
      },
    ]);
    // Bare adopt deployment: truthy containerId (so we reach resolveTargetUrl),
    // runtime does NOT support containerIp → host resolves to 127.0.0.1.
    findDeployment.mockResolvedValue({
      id: "dep-1",
      containerId: "dep-1",
      meta: { runtimeMode: "bare" },
      organizationId: "org-1",
    });
    resolveRuntime.mockResolvedValue({
      routing: { provider: "bare" },
      runtime: { name: "bare", supports: () => false },
      effectiveTarget: "local",
      serverId: null,
    });
  });

  it("registers the self-app's own loopback dashboard route when isSelfApp is set", async () => {
    await reapplyProjectLiveRoutes(project, [], { isSelfApp: true });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers).toEqual([
      {
        hostname: "panel.example.com",
        targetUrl: "http://127.0.0.1:3001",
        isCustomDomain: false,
        observedLoopbackPublishes: [{ serviceId: null, containerPort: 3001, hostPort: 3001 }],
      },
    ]);
  });

  it("still refuses the same loopback dashboard route for an ordinary tenant project", async () => {
    await reapplyProjectLiveRoutes(project, []);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers).toEqual([]);
  });
});

/**
 * A domain targets a PORT (proxy to a container) or a PATH (serve files) — never
 * both. The live edit path handled only the port kind and `continue`d on the
 * other, so adding or editing a domain on a STATIC project wrote no vhost at all:
 * the hostname fell through to `default_server`. The deploy path DOES emit a
 * static root, so the same domain worked after a redeploy — which is why this read
 * as "free domains work for proxied projects and do nothing for static ones".
 */
describe("reapplyProjectLiveRoutes static (path-targeted) routes", () => {
  const staticProject = {
    id: "proj-site",
    slug: "site",
    port: null,
    cloudWorkspaceId: null,
    activeDeploymentId: "dep-1",
    organizationId: "org-1",
    webhookDomain: null,
    routeStrategy: null,
    // A static project runs no server process — that's what makes it static.
    hasServer: false,
    outputDirectory: "dist",
  };

  /** `containerId` on a static-file-serve deployment is its release root on the host. */
  const deployment = (meta: Record<string, unknown>) => ({
    id: "dep-1",
    containerId: "/var/lib/openship/releases/site-42",
    meta,
    organizationId: "org-1",
  });

  const domain = (targetPath: string, hostname = "sadsa.opsh.io") => ({
    id: "dom-1",
    hostname,
    isPrimary: true,
    serviceId: null,
    targetPort: null,
    targetPath,
    domainType: "free",
  });

  beforeEach(() => {
    reconcile.mockReset().mockResolvedValue(undefined);
    resolveRuntime.mockReset();
    findDeployment.mockReset();
    listByProject.mockReset();
    syncManagedEdge.mockReset().mockResolvedValue({ failures: [] });
    deregisterManagedEdge.mockReset().mockResolvedValue({ failures: [] });
    resolveRuntime.mockResolvedValue({
      routing: { provider: "bare" },
      runtime: { name: "bare", supports: () => false },
      effectiveTarget: "local",
      serverId: null,
    });
  });

  it("registers a doc root for a path-targeted domain instead of skipping it", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(reconcile.mock.calls[0][1].registers).toEqual([
      {
        hostname: "sadsa.opsh.io",
        isCustomDomain: false,
        staticRoot: "/var/lib/openship/releases/site-42/dist",
      },
    ]);
  });

  // A lone static site is not a 1-static + 1-server monorepo, so `planCompositeRoute`
  // returned null and `compileVercelRouting` was never reached — the whole vercel.json
  // routing block was silently ignored for the commonest project shape there is.
  it("applies vercel.json routing to a single-service project", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(
      {
        ...staticProject,
        routingConfig: {
          redirects: [{ source: "/blog/:path*", destination: "/news/:path*", permanent: true }],
          headers: [
            { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
          ],
          cleanUrls: true,
          trailingSlash: false,
        },
      },
      [],
    );

    expect(reconcile.mock.calls[0][1].registers).toEqual([
      {
        hostname: "sadsa.opsh.io",
        isCustomDomain: false,
        redirects: [
          {
            path: "/blog/",
            exact: false,
            statusCode: 308,
            destination: "/news/$1",
            pattern: "/blog/(.*)",
          },
        ],
        headerRules: [{ path: "/api/", headers: [{ key: "Cache-Control", value: "no-store" }] }],
        cleanUrls: true,
        trailingSlash: false,
        staticRoot: "/var/lib/openship/releases/site-42/dist",
      },
    ]);
  });

  it("emits no routing fields when the project has no vercel.json", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(Object.keys(reconcile.mock.calls[0][1].registers[0])).toEqual([
      "hostname",
      "isCustomDomain",
      "staticRoot",
    ]);
  });

  // Which upstream a path rewrite belongs to is a topology question this per-domain
  // path can't answer, so it leaves those to the composite path rather than guessing
  // the frontend. A full-URL rewrite needs no backend and still compiles.
  it("compiles an external rewrite but leaves backend-bound ones to the composite path", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(
      {
        ...staticProject,
        routingConfig: {
          rewrites: [
            { source: "/ext/:p*", destination: "https://api.example.com/v2/:p*" },
            { source: "/api/(.*)", destination: "/api/index.js" },
          ],
        },
      },
      [],
    );

    expect(reconcile.mock.calls[0][1].registers[0].proxyLocations).toEqual([
      {
        pathPrefix: "/ext/",
        external: true,
        targetUrl: "https://api.example.com",
        pattern: "/ext/(.*)",
        upstreamPath: "/v2/$1",
      },
    ]);
  });

  it("serves a subpath from that directory beneath the root", async () => {
    listByProject.mockResolvedValue([domain("/docs")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(reconcile.mock.calls[0][1].registers[0].staticRoot).toBe(
      "/var/lib/openship/releases/site-42/dist/docs",
    );
  });

  it('honours a RECORDED empty output dir — "" is a real answer, not a missing one', async () => {
    // A Docker-sandbox static build already extracted the doc root, so it serves
    // from the release root and records "". Treating that as absent and falling
    // back to project.outputDirectory points the vhost one directory too deep at
    // a path that doesn't exist — a 404 on the most common static build.
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "" }));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(reconcile.mock.calls[0][1].registers[0].staticRoot).toBe(
      "/var/lib/openship/releases/site-42",
    );
  });

  it("falls back to the project's output dir for a deployment predating the meta field", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({}));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(reconcile.mock.calls[0][1].registers[0].staticRoot).toBe(
      "/var/lib/openship/releases/site-42/dist",
    );
  });

  it("syncs the free domain of a static project on Openship Cloud's edge", async () => {
    // The other half of the same bug: the edge route is `<slug>.opsh.io` → this
    // server's :80. What the vhost then does with the request is a local matter,
    // so excluding path targets here left static free domains with no edge route.
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(syncManagedEdge).toHaveBeenCalledTimes(1);
    expect(syncManagedEdge.mock.calls[0][0]).toEqual([
      { hostname: "sadsa.opsh.io", subdomain: "sadsa" },
    ]);
  });

  it("does not report route re-apply quiescent while managed-edge sync is still writing", async () => {
    let releaseSync!: () => void;
    syncManagedEdge.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSync = () => resolve({ failures: [] });
      }),
    );
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    let settled = false;
    const applying = reapplyProjectLiveRoutes(staticProject, []).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(syncManagedEdge).toHaveBeenCalled());
    expect(settled).toBe(false);

    releaseSync();
    await applying;
    expect(settled).toBe(true);
  });

  it("does not re-sync a hostname that was already present", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "dist" }));

    await reapplyProjectLiveRoutes(staticProject, ["sadsa.opsh.io"]);

    expect(syncManagedEdge).not.toHaveBeenCalled();
  });

  it("skips the route (rather than registering a bogus root) when no root resolves", async () => {
    listByProject.mockResolvedValue([domain("/")]);
    // An absolute outputDirectory is rejected by resolveStaticOutputPath.
    findDeployment.mockResolvedValue(deployment({ staticServeOutputDir: "/etc" }));

    await reapplyProjectLiveRoutes(staticProject, []);

    expect(reconcile.mock.calls[0][1].registers).toEqual([]);
  });

  it("keeps proxying a project that DOES run a server, even with a path row", async () => {
    // hasServer is the discriminator: a server project's route is an upstream, and
    // a stray path row must not turn it into a file server.
    listByProject.mockResolvedValue([{ ...domain("/"), targetPort: 3000, targetPath: null }]);
    findDeployment.mockResolvedValue(deployment({ runtimeMode: "bare" }));

    await reapplyProjectLiveRoutes({ ...staticProject, hasServer: true, port: 3000 }, []);

    expect(reconcile.mock.calls[0][1].registers[0]).toMatchObject({
      hostname: "sadsa.opsh.io",
      targetUrl: "http://127.0.0.1:3000",
      observedLoopbackPublishes: [{ serviceId: null, containerPort: 3000, hostPort: 3000 }],
    });
  });
});

/**
 * The submitted-route funnel. Project create/ensure/update and
 * POST /deployments/build/access all reach the domain rows through here, so this is
 * where a bogus custom hostname is refused once for all of them (#342) — nginx's own
 * DOMAIN_RE would happily render `server_name localhost;`.
 */
describe("deriveNextProjectRouteState custom-hostname gate", () => {
  const project = { slug: "portfolio" };

  for (const customDomain of ["localhost", "127.0.0.1", "single", "example.com:8080", "a b.com"]) {
    it(`refuses a submitted ${JSON.stringify(customDomain)}`, () => {
      expect(() =>
        deriveNextProjectRouteState(project, {
          nextPublicEndpoints: [{ customDomain, domainType: "custom", port: 3000 }],
        }),
      ).toThrow(/is not a valid custom domain/);
    });
  }

  it("refuses the legacy scalar customDomain too", () => {
    expect(() => deriveNextProjectRouteState(project, { customDomain: "localhost" })).toThrow(
      /is not a valid custom domain/,
    );
  });

  it("accepts a real hostname, scheme and all", () => {
    const state = deriveNextProjectRouteState(project, {
      nextPublicEndpoints: [
        { customDomain: "HTTPS://App.Example.com/", domainType: "custom", port: 3000 },
      ],
    });

    expect(state.publicEndpoints[0]).toMatchObject({ customDomain: "app.example.com" });
  });

  /**
   * The load-bearing half of the gate: a project that ALREADY holds a bad hostname —
   * persisted before the gate existed, or a `localhost` vhost a server migration
   * adopted — must keep deriving, deploying and being editable. Only hostnames the
   * submission INTRODUCES are refused; the endpoint list is authoritative, so every
   * save echoes the stored set back.
   */
  const legacyRow = [
    {
      id: "dom-legacy",
      hostname: "localhost",
      isPrimary: true,
      serviceId: null,
      targetPort: 3000,
      targetPath: null,
      domainType: "custom",
      verified: false,
    },
  ] as never;

  it("does not throw on a bad hostname that is already stored", () => {
    expect(() => deriveNextProjectRouteState(project, { projectDomains: legacyRow })).not.toThrow();
  });

  it("lets that project echo its own bad hostname back on a save", () => {
    expect(() =>
      deriveNextProjectRouteState(project, {
        projectDomains: legacyRow,
        nextPublicEndpoints: [
          { customDomain: "localhost", domainType: "custom", port: 3000 },
          { customDomain: "app.example.com", domainType: "custom", port: 3000 },
        ],
      }),
    ).not.toThrow();
  });

  it("lets that project drop the bad hostname", () => {
    expect(() =>
      deriveNextProjectRouteState(project, {
        projectDomains: legacyRow,
        nextPublicEndpoints: [
          { customDomain: "app.example.com", domainType: "custom", port: 3000 },
        ],
      }),
    ).not.toThrow();
  });

  it("still refuses a DIFFERENT bad hostname on that project", () => {
    expect(() =>
      deriveNextProjectRouteState(project, {
        projectDomains: legacyRow,
        nextPublicEndpoints: [{ customDomain: "127.0.0.1", domainType: "custom", port: 3000 }],
      }),
    ).toThrow(/"127.0.0.1" is not a valid custom domain/);
  });
});

/**
 * Issue #618: a project MIGRATED into Openship (adopted in place) verified its
 * domain, took a certificate — and never got a vhost. Both re-attach paths store
 * the COMPOSE_SENTINEL in `deployment.container_id` (migrate.service.ts →
 * reattachRuntime / attachLiveRuntime), and this re-apply treated that as "there is
 * no upstream to point a project-level route at": it applied `removes` and returned,
 * so `sites-enabled` stayed empty while the domain read Verified + SSL Active.
 *
 * A multi-service release resolves the route through the SERVICE that owns its port
 * instead. The port is what the operator sets in the Domains tab ("Mapped to"), and
 * it has to beat the primary-container guess — the service list is dependency-
 * ordered, so the guess resolves to the DATABASE (#498).
 */
describe("reapplyProjectLiveRoutes multi-service project-level routes (issue #618)", () => {
  const project = {
    id: "proj-dependabot",
    slug: "dependabot",
    port: null,
    cloudWorkspaceId: null,
    activeDeploymentId: "dep-1",
    organizationId: "org-1",
    webhookDomain: null,
    routeStrategy: null,
    hasServer: true,
    outputDirectory: null,
  };

  /**
   * The adopted stack from the issue: postgres FIRST (adoption records services in
   * discovery order, and a `find`-the-first-container guess lands there), and every
   * service `exposed: false` — adoption leaves them unexposed on purpose and points
   * the operator at the project's Domains tab instead (migrate.service.ts), which is
   * precisely the affordance that had no writer.
   */
  const services = [
    { id: "svc-postgres", name: "postgres", enabled: true, exposed: false, ports: ["5432"] },
    { id: "svc-web", name: "web", enabled: true, exposed: false, ports: ["3000"] },
    { id: "svc-worker", name: "worker", enabled: true, exposed: false, ports: [] },
  ];

  const liveRows = [
    { serviceId: "svc-postgres", containerId: "c-postgres", ip: "10.0.0.3", hostPort: null },
    { serviceId: "svc-web", containerId: "c-web", ip: "10.0.0.2", hostPort: 3000 },
    { serviceId: "svc-worker", containerId: "c-worker", ip: "10.0.0.4", hostPort: null },
  ];

  const projectDomain = (targetPort: number | null) => ({
    id: "dom-1",
    hostname: "app.example.com",
    isPrimary: true,
    serviceId: null,
    targetPort,
    targetPath: null,
    domainType: "custom",
    verified: true,
  });

  /** A route writer must observe the container as RUNNING before publishing. */
  const liveDockerRuntime = {
    name: "docker",
    supports: (feature: string) => feature === "containerInfo" || feature === "containerIp",
    getContainerInfo: async (id: string) => {
      const rows = await listServicesByDeployment();
      const row = rows.find(
        (candidate: { containerId?: string | null }) => candidate.containerId === id,
      );
      return row
        ? {
            containerId: id,
            status: "running",
            ip: row.ip ?? undefined,
            hostPort: row.hostPort ?? undefined,
            hostPortByContainerPort: row.hostPorts ?? undefined,
          }
        : { containerId: id, status: "missing" };
    },
    getContainerIp: async (id: string) => {
      const rows = await listServicesByDeployment();
      return (
        rows.find((candidate: { containerId?: string | null }) => candidate.containerId === id)
          ?.ip ?? null
      );
    },
  };

  beforeEach(() => {
    reconcile.mockReset().mockResolvedValue(undefined);
    resolveRuntime.mockReset();
    findDeployment.mockReset();
    listByProject.mockReset();
    syncManagedEdge.mockReset().mockResolvedValue({ failures: [] });
    deregisterManagedEdge.mockReset().mockResolvedValue({ failures: [] });

    // The adopted deployment: the sentinel, NOT a container id.
    findDeployment.mockResolvedValue({
      id: "dep-1",
      containerId: "compose",
      meta: { deployTarget: "server", serverId: "srv-1", runtimeMode: "docker", adopt: true },
      organizationId: "org-1",
    });
    listServicesByProject.mockResolvedValue(services);
    listServicesByDeployment.mockResolvedValue(liveRows);
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: liveDockerRuntime,
      effectiveTarget: "server",
      serverId: "srv-1",
    });
  });

  it("registers the domain against the service that owns its port instead of skipping it", async () => {
    listByProject.mockResolvedValue([projectDomain(3000)]);

    await reapplyProjectLiveRoutes(project, []);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers).toEqual([
      {
        hostname: "app.example.com",
        isCustomDomain: true,
        targetUrl: "http://127.0.0.1:3000",
        observedLoopbackPublishes: [{ serviceId: "svc-web", containerPort: 3000, hostPort: 3000 }],
      },
    ]);
  });

  it("picks the port's owner, not the dependency-ordered first service", async () => {
    listByProject.mockResolvedValue([projectDomain(3000)]);
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: liveDockerRuntime,
      effectiveTarget: "server",
      serverId: "srv-1",
    });

    await reapplyProjectLiveRoutes({ ...project, routeStrategy: "container-ip" }, []);

    // 10.0.0.2 is web. postgres (10.0.0.3) is first in the list and would have won
    // a `find`-the-first-container guess.
    expect(reconcile.mock.calls[0][1].registers).toEqual([
      { hostname: "app.example.com", isCustomDomain: true, targetUrl: "http://10.0.0.2:3000" },
    ]);
  });

  it("matches a route pointed at the PUBLISHED port and still dials the container port", async () => {
    listByProject.mockResolvedValue([projectDomain(8080)]);
    listServicesByProject.mockResolvedValue([
      services[0],
      { id: "svc-web", name: "web", enabled: true, exposed: false, ports: ["8080:3000"] },
    ]);
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: liveDockerRuntime,
      effectiveTarget: "server",
      serverId: "srv-1",
    });

    await reapplyProjectLiveRoutes({ ...project, routeStrategy: "container-ip" }, []);

    // The operator named 8080 (the host half). Inside the container the app listens
    // on 3000 — dialing 10.0.0.2:8080 would hit nothing.
    expect(reconcile.mock.calls[0][1].registers).toEqual([
      { hostname: "app.example.com", isCustomDomain: true, targetUrl: "http://10.0.0.2:3000" },
    ]);
  });

  it("skips a route whose port no service declares rather than guessing a service", async () => {
    // 9999 is declared nowhere and this release has no primary container to fall back
    // on. Answering "the first service" would proxy the operator's public domain at
    // postgres — the failure the sentinel guard was added to stop. Skip it and log
    // which ports ARE on offer instead.
    listByProject.mockResolvedValue([projectDomain(9999)]);
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: liveDockerRuntime,
      effectiveTarget: "server",
      serverId: "srv-1",
    });

    await reapplyProjectLiveRoutes({ ...project, routeStrategy: "container-ip" }, []);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers ?? []).toEqual([]);
  });

  it("falls back to the release's own primary container for an unmatched port", async () => {
    // Same unmatched port, but this compose release DID come up with a primary
    // container. That is what resolved the route before this change, so it still does.
    listByProject.mockResolvedValue([projectDomain(9999)]);
    findDeployment.mockResolvedValue({
      id: "dep-1",
      containerId: "c-web",
      meta: { deployTarget: "server", serverId: "srv-1", runtimeMode: "docker" },
      organizationId: "org-1",
    });
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: liveDockerRuntime,
      effectiveTarget: "server",
      serverId: "srv-1",
    });

    await reapplyProjectLiveRoutes({ ...project, routeStrategy: "container-ip" }, []);

    expect(reconcile.mock.calls[0][1].registers).toEqual([
      { hostname: "app.example.com", isCustomDomain: true, targetUrl: "http://10.0.0.2:9999" },
    ]);
  });

  it("dials the owner's PUBLISHED host port under the default loopback-port strategy", async () => {
    // Discriminating fixture: the publish (32770) differs from the container port
    // (3000), so the asserted URL can only come from the row's host port. The suite's
    // faithful #618 fixture has them equal, which cannot tell the two apart.
    listByProject.mockResolvedValue([projectDomain(3000)]);
    listServicesByDeployment.mockResolvedValue([
      { serviceId: "svc-postgres", containerId: "c-postgres", ip: "10.0.0.3", hostPort: 5432 },
      { serviceId: "svc-web", containerId: "c-web", ip: "10.0.0.2", hostPort: 32770 },
    ]);

    await reapplyProjectLiveRoutes(project, []);

    expect(reconcile.mock.calls[0][1].registers).toEqual([
      {
        hostname: "app.example.com",
        isCustomDomain: true,
        targetUrl: "http://127.0.0.1:32770",
        observedLoopbackPublishes: [{ serviceId: "svc-web", containerPort: 3000, hostPort: 32770 }],
      },
    ]);
  });

  it("prefers the port's owner over the release's own primary container", async () => {
    // This release HAS a real primary container — and it is the WRONG one for the
    // route's port. HEAD resolved project-level routes through it unconditionally, so
    // this is the case that fails if the service resolution is removed.
    listByProject.mockResolvedValue([projectDomain(3000)]);
    findDeployment.mockResolvedValue({
      id: "dep-1",
      containerId: "c-postgres",
      meta: { deployTarget: "server", serverId: "srv-1", runtimeMode: "docker" },
      organizationId: "org-1",
    });
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: liveDockerRuntime,
      effectiveTarget: "server",
      serverId: "srv-1",
    });

    await reapplyProjectLiveRoutes({ ...project, routeStrategy: "container-ip" }, []);

    // web (10.0.0.2), not the primary container postgres (10.0.0.3).
    expect(reconcile.mock.calls[0][1].registers).toEqual([
      { hostname: "app.example.com", isCustomDomain: true, targetUrl: "http://10.0.0.2:3000" },
    ]);
  });

  it("still skips registration when no service has a container to route to", async () => {
    listByProject.mockResolvedValue([projectDomain(3000)]);
    listServicesByDeployment.mockResolvedValue([
      { serviceId: "svc-web", containerId: null, ip: null, hostPort: null },
    ]);

    await reapplyProjectLiveRoutes(project, []);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers ?? []).toEqual([]);
  });

  it("leaves a single-app release on the deployment's own container", async () => {
    listByProject.mockResolvedValue([projectDomain(3000)]);
    listServicesByDeployment.mockResolvedValue([]);
    listServicesByProject.mockResolvedValue([]);
    findDeployment.mockResolvedValue({
      id: "dep-1",
      containerId: "c-single",
      meta: { runtimeMode: "docker" },
      organizationId: "org-1",
    });
    resolveRuntime.mockResolvedValue({
      routing: { provider: "docker" },
      runtime: {
        name: "docker",
        supports: (feature: string) => feature === "containerInfo" || feature === "containerIp",
        getContainerInfo: async (id: string) => ({
          containerId: id,
          status: "running",
          ip: id === "c-single" ? "10.0.0.9" : undefined,
        }),
        getContainerIp: async (id: string) => (id === "c-single" ? "10.0.0.9" : null),
      },
      effectiveTarget: "server",
      serverId: "srv-1",
    });

    await reapplyProjectLiveRoutes({ ...project, routeStrategy: "container-ip" }, []);

    expect(reconcile.mock.calls[0][1].registers).toEqual([
      { hostname: "app.example.com", isCustomDomain: true, targetUrl: "http://10.0.0.9:3000" },
    ]);
  });
});
