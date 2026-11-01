import { describe, expect, it } from "vitest";
import type { Service } from "@repo/db";
import type { MigrationServiceRoutes } from "@repo/contracts";
import {
  planMigrationRoutes,
  remapMigrationRoutes,
  findOmittedMigrationRootRoutes,
} from "@repo/platform/engine/modules/migration/migration-routes";
import type { DiscoveredService } from "@repo/platform/engine/modules/migration/docker-reconcile";
import { buildDomainFanoutRegistrations } from "@repo/platform/engine/modules/deployments/compose/composite-route";

const service = (name: string, port = "3000") =>
  ({ id: `svc-${name}`, name, ports: [port], enabled: true }) as Service;
const route = (hostname: string, exposedPort = "3000") => ({
  domainType: "custom" as const,
  customDomain: hostname,
  exposedPort,
});

describe("reviewed migration routes", () => {
  it("asks for a decision only when a real source catch-all was omitted", () => {
    const selected = {
      api: { ...route("api.onvo.me"), targetPath: "/v3" },
    };
    expect(findOmittedMigrationRootRoutes(selected, [
      { domains: ["api.onvo.me"], path: "/v3" },
      { domains: ["api.onvo.me"], path: "/", exact: true },
    ])).toEqual([]);
    const source = [{ domains: ["API.ONVO.ME"], path: "/" }];
    expect(findOmittedMigrationRootRoutes(selected, source)).toEqual(["api.onvo.me"]);
    expect(findOmittedMigrationRootRoutes({ ...selected, web: route("api.onvo.me") }, source)).toEqual([]);
    expect(findOmittedMigrationRootRoutes(undefined, source)).toEqual([]);
  });
  it("maps UID-keyed wizard input onto renamed rows without mixing same-named containers", () => {
    const chosen = [
      { name: "web", containerId: "container-shop" },
      { name: "web", containerId: "container-admin" },
    ] as DiscoveredService[];
    const routes = remapMigrationRoutes(
      {
        "container-shop": [route("shop.example.com")],
        "container-admin": [route("admin.example.com")],
        worker: [route("worker.example.com")],
      },
      chosen,
      { "container-shop": "storefront", "container-admin": "admin" },
    );
    const plan = planMigrationRoutes(
      [service("storefront"), service("admin"), service("worker")],
      routes!,
    );
    expect(plan.domains.map((entry) => [entry.hostname, entry.service.id])).toEqual([
      ["worker.example.com", "svc-worker"],
      ["shop.example.com", "svc-storefront"],
      ["admin.example.com", "svc-admin"],
    ]);
  });

  it("accepts legacy name keys but gives a container ID override precedence", () => {
    const chosen = [{ name: "web", containerId: "container-web" }] as DiscoveredService[];
    const names = { "container-web": "frontend" };
    expect(remapMigrationRoutes({ web: route("legacy.example.com") }, chosen, names)).toEqual({
      frontend: route("legacy.example.com"),
    });
    expect(
      remapMigrationRoutes(
        { "container-web": route("current.example.com"), web: route("legacy.example.com") },
        chosen,
        names,
      ),
    ).toEqual({ frontend: route("current.example.com") });
  });

  it("retains aliases and path fan-out through the canonical deployment renderer", () => {
    const routes: MigrationServiceRoutes = {
      web: [route("shop.example.com", "8080"), route("www.example.com", "8080")],
      api: [{ ...route("shop.example.com", "9000"), targetPath: "/api" }],
    };
    const plan = planMigrationRoutes([service("web"), service("api")], routes);
    expect(plan.domains.map((entry) => entry.hostname)).toEqual([
      "shop.example.com",
      "www.example.com",
    ]);
    expect(plan.endpointsByService.get("svc-web")).toHaveLength(1);
    const registers = buildDomainFanoutRegistrations({
      routes: plan.composites,
      resolveTargetUrl: (id, port) => `http://${id}:${port}`,
    });
    expect(registers).toEqual([
      {
        hostname: "shop.example.com",
        isCustomDomain: true,
        targetUrl: "http://svc-web:8080",
        proxyLocations: [{ pathPrefix: "/api", targetUrl: "http://svc-api:9000" }],
      },
      { hostname: "www.example.com", isCustomDomain: true, targetUrl: "http://svc-web:8080" },
    ]);
  });

  it("refuses unknown service references and contradictory route ownership", () => {
    expect(() =>
      planMigrationRoutes([service("web")], { stale: route("shop.example.com") }),
    ).toThrow(/unknown migrated service/);
    expect(() =>
      planMigrationRoutes([service("web"), service("api")], {
        web: route("shop.example.com"),
        api: route("shop.example.com"),
      }),
    ).toThrow(/more than one service/);
  });

  it("migrates path-only domains without creating a catch-all service endpoint", () => {
    const plan = planMigrationRoutes([service("api"), service("llmproxy")], {
      api: [{ ...route("api.onvo.me", "9000"), targetPath: "/v3" }],
      llmproxy: [{ ...route("api.onvo.me", "4000"), targetPath: "/mcp", exact: true }],
    });
    expect(plan.endpointsByService.size).toBe(0);
    expect(plan.domains.map((entry) => entry.hostname)).toEqual(["api.onvo.me"]);
    expect(plan.composites).toEqual([{
      hostname: "api.onvo.me",
      isCustomDomain: true,
      locations: [
        { pathPrefix: "/v3", serviceId: "svc-api", port: 9000 },
        { pathPrefix: "/mcp", serviceId: "svc-llmproxy", port: 4000, exact: true },
      ],
    }]);
    expect(buildDomainFanoutRegistrations({
      routes: plan.composites,
      resolveTargetUrl: (id, port) => `http://${id}:${port}`,
    })).toEqual([{
      hostname: "api.onvo.me",
      isCustomDomain: true,
      notFound: true,
      proxyLocations: [
        { pathPrefix: "/v3", targetUrl: "http://svc-api:9000" },
        { pathPrefix: "/mcp", targetUrl: "http://svc-llmproxy:4000", exact: true },
      ],
    }]);
  });

  it("keeps an exact root match from becoming a prefix catch-all", () => {
    const plan = planMigrationRoutes([service("api")], {
      api: { ...route("api.onvo.me"), targetPath: "/", exact: true },
    });
    expect(plan.endpointsByService.size).toBe(0);
    expect(plan.composites[0].rootServiceId).toBeUndefined();
    expect(plan.composites[0].locations).toEqual([
      { pathPrefix: "/", serviceId: "svc-api", port: 3000, exact: true },
    ]);
  });
});
