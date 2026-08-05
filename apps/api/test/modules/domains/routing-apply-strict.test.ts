import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  findProject: vi.fn(),
  findDeployment: vi.fn(),
  listServices: vi.fn(),
  listLive: vi.fn(),
  listDomains: vi.fn(),
  resolveRuntime: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: state.findProject },
    deployment: { findById: state.findDeployment },
    service: {
      listByProject: state.listServices,
      listByDeployment: state.listLive,
    },
    domain: { listByProject: state.listDomains },
  },
}));

vi.mock("../../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "local" }),
}));

vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/deployment-runtime")>()),
  resolveDeploymentRuntime: state.resolveRuntime,
  usesManagedRouting: () => true,
}));

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: state.reconcile,
}));

import { applyProjectRouting } from "../../../src/modules/domains/routing-apply.service";

const project = {
  id: "proj-1",
  slug: "app",
  activeDeploymentId: "dep-1",
  routeStrategy: "loopback-port",
  port: 4173,
  compositeRoutes: null,
  routingConfig: {
    rewrites: [
      { source: "/backend/(.*)", destination: "/backend/index.js" },
      { source: "/(.*)", destination: "/index.html" },
    ],
    redirects: [{ source: "/old", destination: "/new", permanent: true }],
    headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
  },
};

const web = {
  id: "web",
  projectId: "proj-1",
  name: "web",
  kind: "monorepo",
  framework: "vite",
  startCommand: "",
  enabled: true,
  exposed: true,
  exposedPort: "4173",
  ports: ["4173"],
  domainType: "custom",
  customDomain: "app.example.com",
  publicEndpoints: null,
};

const api = {
  id: "api",
  projectId: "proj-1",
  name: "api",
  kind: "monorepo",
  framework: "express",
  startCommand: "npm start",
  enabled: true,
  exposed: false,
  exposedPort: "3000",
  ports: ["3000"],
  publicEndpoints: null,
};

describe("applyProjectRouting strict recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.findProject.mockResolvedValue(project);
    state.findDeployment.mockResolvedValue({ id: "dep-1" });
    state.listServices.mockResolvedValue([web, api]);
    state.listLive.mockResolvedValue([
      { serviceId: "web", imageRef: "/opt/openship/static/proj-1/web" },
      { serviceId: "api", ip: "172.18.0.10", hostPort: 49300 },
    ]);
    state.listDomains.mockResolvedValue([
      {
        hostname: "app.example.com",
        externalIngress: false,
        manualSsl: false,
      },
    ]);
    state.resolveRuntime.mockResolvedValue({
      routing: { provider: "remote-or-local-edge" },
      runtime: { name: "docker" },
      effectiveTarget: "server",
    });
    state.reconcile.mockResolvedValue(undefined);
  });

  it("retains static root, rewrites, redirects and headers for a composite hostname", async () => {
    await expect(
      applyProjectRouting("proj-1", { strict: true, onlyHostname: "app.example.com" }),
    ).resolves.toBe(true);

    expect(state.reconcile).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        strict: true,
        routing: { provider: "remote-or-local-edge" },
        registers: [
          {
            hostname: "app.example.com",
            isCustomDomain: true,
            tls: true,
            terminatesTlsLocally: true,
            staticRoot: "/opt/openship/static/proj-1/web",
            proxyLocations: [
              {
                pathPrefix: "/backend/",
                targetUrl: "http://127.0.0.1:49300",
              },
            ],
            redirects: [{ path: "/old", exact: true, statusCode: 308, destination: "/new" }],
            headerRules: [
              {
                path: "/",
                headers: [{ key: "X-Frame-Options", value: "DENY" }],
              },
            ],
          },
        ],
      }),
    );
  });

  it("fails closed instead of replacing an incomplete composite with a plain route", async () => {
    state.listLive.mockResolvedValue([
      { serviceId: "web", imageRef: "/opt/openship/static/proj-1/web" },
      { serviceId: "api", ip: null, hostPort: null },
    ]);

    await expect(
      applyProjectRouting("proj-1", { strict: true, onlyHostname: "app.example.com" }),
    ).rejects.toThrow("compiled route");
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("preserves external-ingress TLS ownership on the compiled route", async () => {
    state.listDomains.mockResolvedValue([
      {
        hostname: "app.example.com",
        externalIngress: true,
        manualSsl: false,
      },
    ]);

    await applyProjectRouting("proj-1", { strict: true, onlyHostname: "app.example.com" });

    expect(state.reconcile.mock.calls[0][1].registers[0]).toMatchObject({
      hostname: "app.example.com",
      tls: false,
      terminatesTlsLocally: false,
    });
  });

  it("preserves a canonical redirect on a repaired composite route", async () => {
    state.listDomains.mockResolvedValue([
      {
        hostname: "app.example.com",
        externalIngress: false,
        manualSsl: false,
        redirectTo: "canonical.example.com",
        redirectStatus: 308,
      },
      { hostname: "canonical.example.com", externalIngress: false, manualSsl: false },
    ]);

    await applyProjectRouting("proj-1", { strict: true, onlyHostname: "app.example.com" });

    expect(state.reconcile.mock.calls[0][1].registers[0]).toMatchObject({
      hostname: "app.example.com",
      redirectHost: { target: "canonical.example.com", statusCode: 308 },
    });
  });

  it("fails closed when a strict fanout route has an unresolved secondary location", async () => {
    const worker = {
      ...api,
      id: "worker",
      name: "worker",
      exposedPort: "3001",
      ports: ["3001"],
    };
    state.findProject.mockResolvedValue({
      ...project,
      routingConfig: null,
      compositeRoutes: [
        {
          hostname: "fanout.example.com",
          isCustomDomain: true,
          rootServiceId: "api",
          locations: [{ pathPrefix: "/worker", serviceId: "worker" }],
        },
      ],
    });
    state.listServices.mockResolvedValue([api, worker]);
    state.listLive.mockResolvedValue([{ serviceId: "api", ip: "172.18.0.10", hostPort: 49300 }]);
    state.listDomains.mockResolvedValue([
      { hostname: "fanout.example.com", externalIngress: false, manualSsl: false },
    ]);

    await expect(
      applyProjectRouting("proj-1", { strict: true, onlyHostname: "fanout.example.com" }),
    ).rejects.toThrow("/worker upstream");
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("preserves a canonical redirect on a complete fanout route", async () => {
    const worker = {
      ...api,
      id: "worker",
      name: "worker",
      exposedPort: "3001",
      ports: ["3001"],
    };
    state.findProject.mockResolvedValue({
      ...project,
      routingConfig: null,
      compositeRoutes: [
        {
          hostname: "fanout.example.com",
          isCustomDomain: true,
          rootServiceId: "api",
          locations: [{ pathPrefix: "/worker", serviceId: "worker" }],
        },
      ],
    });
    state.listServices.mockResolvedValue([api, worker]);
    state.listLive.mockResolvedValue([
      { serviceId: "api", ip: "172.18.0.10", hostPort: 49300 },
      { serviceId: "worker", ip: "172.18.0.11", hostPort: 49301 },
    ]);
    state.listDomains.mockResolvedValue([
      {
        hostname: "fanout.example.com",
        externalIngress: false,
        manualSsl: false,
        redirectTo: "canonical.example.com",
        redirectStatus: 301,
      },
      { hostname: "canonical.example.com", externalIngress: false, manualSsl: false },
    ]);

    await applyProjectRouting("proj-1", { strict: true, onlyHostname: "fanout.example.com" });

    expect(state.reconcile.mock.calls[0][1].registers[0]).toMatchObject({
      hostname: "fanout.example.com",
      targetUrl: "http://127.0.0.1:49300",
      proxyLocations: [{ pathPrefix: "/worker", targetUrl: "http://127.0.0.1:49301" }],
      redirectHost: { target: "canonical.example.com", statusCode: 301 },
    });
  });
});
