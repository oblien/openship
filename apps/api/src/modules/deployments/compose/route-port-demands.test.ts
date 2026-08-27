import { describe, expect, it } from "vitest";

import { collectComposeRoutePortDemands } from "./route-port-demands";

const project = {
  id: "proj-a",
  name: "app",
  slug: "app",
  port: null,
  routeStrategy: "loopback-port",
  routingConfig: null,
  compositeRoutes: null,
};

const service = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "svc-web",
    projectId: "proj-a",
    name: "web",
    kind: "compose",
    enabled: true,
    exposed: false,
    exposedPort: null,
    ports: ["8080:3000"],
    publicEndpoints: null,
    ...overrides,
  }) as never;

describe("collectComposeRoutePortDemands", () => {
  it("pins an unexposed service reached only by a project-level published-port route", () => {
    const demands = collectComposeRoutePortDemands({
      project: project as never,
      services: [service()],
      domainRows: [
        {
          id: "dom-a",
          projectId: "proj-a",
          serviceId: null,
          hostname: "app.example.com",
          targetPort: 8080,
          targetPath: null,
          domainType: "custom",
          verified: true,
          isPrimary: true,
        } as never,
      ],
      runtimeName: "docker",
      usesManagedRouting: true,
    });

    // The domain names the declared host side (8080), but Docker and the edge
    // need the claim for the container side (3000) that will be republished on a
    // pinned loopback host port.
    expect([...demands.get("svc-web")!]).toEqual([3000]);
  });

  it("unions service, composite, and fan-out demands without duplicates", () => {
    const frontend = service({
      id: "svc-front",
      name: "front",
      kind: "monorepo",
      framework: "vite",
      exposed: true,
      exposedPort: "4173",
      ports: [],
      customDomain: "app.example.com",
      domainType: "custom",
    });
    const backend = service({
      id: "svc-api",
      name: "api",
      kind: "monorepo",
      framework: "express",
      startCommand: "node server.js",
      exposed: false,
      ports: ["3000"],
    });
    const worker = service({ id: "svc-worker", name: "worker", ports: ["9000"] });

    const demands = collectComposeRoutePortDemands({
      project: {
        ...project,
        routingConfig: { rewrites: [{ source: "/api/(.*)", destination: "/api/$1" }] },
        compositeRoutes: [
          {
            hostname: "fanout.example.com",
            isCustomDomain: true,
            rootServiceId: "svc-api",
            locations: [{ pathPrefix: "/jobs", serviceId: "svc-worker" }],
          },
        ],
      } as never,
      services: [frontend, backend, worker],
      domainRows: [],
      runtimeName: "docker",
      usesManagedRouting: true,
    });

    expect([...demands.get("svc-api")!]).toEqual([3000]);
    expect([...demands.get("svc-worker")!]).toEqual([9000]);
    expect([...demands.get("svc-front")!]).toEqual([4173]);
  });
});
