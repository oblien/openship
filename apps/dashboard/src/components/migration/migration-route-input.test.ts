import { describe, expect, it } from "vitest";
import type { DiscoveredService } from "@/lib/api/server-migration";
import { createPublicEndpoint } from "@/context/deployment/types";
import {
  editableServiceRoutes,
  hasIncompleteServiceRoutes,
  hasKeepableRoute,
  keptServiceRoutes,
  toServerRoutes,
} from "./migration-route-input";

describe("migration route request", () => {
  it("sends every reviewed alias, port and path under the selected container's ID", () => {
    const service = {
      existingRoute: [
        {
          port: 18080,
          containerPort: 8080,
          path: "/",
          domains: ["example.com", "www.example.com"],
        },
        { port: 19000, containerPort: 9000, path: "/api", domains: ["example.com"], exact: true },
      ],
    } as DiscoveredService;
    expect(toServerRoutes({ "container-123": keptServiceRoutes(service, "3000") })).toEqual({
      "container-123": [
        { exposedPort: "8080", domainType: "custom", customDomain: "example.com" },
        { exposedPort: "8080", domainType: "custom", customDomain: "www.example.com" },
        {
          exposedPort: "9000",
          domainType: "custom",
          customDomain: "example.com",
          targetPath: "/api",
          exact: true,
        },
      ],
    });
  });

  it("keeps every detected domain, path and port when entering custom routing", () => {
    const service = {
      ports: ["18080:8080"],
      existingRoute: [
        {
          domains: ["example.com", "www.example.com"],
          port: 18080,
          containerPort: 8080,
          path: "/",
          ssl: { enabled: true },
        },
        {
          domains: ["example.com"],
          port: 19000,
          containerPort: 9000,
          path: "/api",
          exact: true,
          ssl: { enabled: true },
        },
      ],
    } as DiscoveredService;
    const routes = editableServiceRoutes(service, undefined, "custom");
    expect(routes).toHaveLength(3);
    expect(routes[2]).toMatchObject({
      customDomain: "example.com",
      port: "9000",
      targetPath: "/api",
      exact: true,
    });
    const free = editableServiceRoutes(service, routes, "free");
    expect(editableServiceRoutes(service, free, "custom")).toEqual(routes);
  });

  it("keeps manual route edits and ids when switching modes", () => {
    const service = { ports: [] } as unknown as DiscoveredService;
    const routes = [
      createPublicEndpoint({
        domainType: "custom",
        customDomain: "edited.example.com",
        domain: "edited",
        port: "8080",
      }),
      createPublicEndpoint({
        domainType: "custom",
        customDomain: "other.example.com",
        port: "9000",
      }),
    ];
    const changed = editableServiceRoutes(service, routes, "free");
    expect(changed.map((route) => route.id)).toEqual(routes.map((route) => route.id));
    expect(changed.map((route) => route.customDomain)).toEqual([
      "edited.example.com",
      "other.example.com",
    ]);
  });

  it("requires an explicit public-route choice to be complete, while allowing automatic port detection", () => {
    expect(hasKeepableRoute({ existingRoute: [] })).toBe(false);
    expect(
      hasKeepableRoute({ existingRoute: [{ domains: [] }] } as unknown as DiscoveredService),
    ).toBe(false);
    expect(hasIncompleteServiceRoutes("none", undefined)).toBe(false);
    expect(hasIncompleteServiceRoutes("keep", undefined)).toBe(false);
    expect(hasIncompleteServiceRoutes("custom", undefined)).toBe(true);
    expect(hasIncompleteServiceRoutes("free", [createPublicEndpoint({ domain: "" })])).toBe(true);
    const route = createPublicEndpoint({
      customDomain: "example.com",
      domainType: "custom",
      port: "",
    });
    expect(hasIncompleteServiceRoutes("custom", [route])).toBe(false);
    for (const port of ["0", "65536", "1.5", "oops"])
      expect(hasIncompleteServiceRoutes("custom", [{ ...route, port }])).toBe(true);
    expect(hasIncompleteServiceRoutes("custom", [{ ...route, port: "8080" }])).toBe(false);
  });
});
