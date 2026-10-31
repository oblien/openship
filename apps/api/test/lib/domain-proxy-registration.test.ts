import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteConfig } from "@repo/adapters";

const state = vi.hoisted(() => ({
  project: {
    id: "project",
    routingConfig: { proxy: { clientMaxBodySize: "2m", proxyReadTimeout: "90s" } },
    deletionInProgress: false,
  },
  domains: [
    { id: "api", projectId: "project", hostname: "api.example.com", proxy: null },
    {
      id: "events",
      projectId: "project",
      hostname: "events.example.com",
      proxy: { clientMaxBodySize: "1m" },
    },
  ] as Array<Record<string, unknown>>,
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => state.project },
    domain: { listByProject: async () => state.domains },
  },
}));
vi.mock("@repo/platform/engine/lib/route-protection", () => ({
  withRouteProtectionLock: async (_id: string, fn: () => Promise<void>) => fn(),
  resolveProjectRouteProtection: async () => ({ routeOptions: { protection: null } }),
}));
import {
  createProjectRouteRegistrar,
  registerProjectRoute,
} from "@repo/platform/engine/lib/project-route-registration";

beforeEach(() => {
  state.project.routingConfig.proxy.clientMaxBodySize = "2m";
  state.project.deletionInProgress = false;
  state.domains[1]!.proxy = { clientMaxBodySize: "1m" };
});

describe("every project route writer resolves saved domain caps (#1431)", () => {
  it("uses current ownership and settings for single-app, service, static and composite registration", async () => {
    const published: RouteConfig[] = [];
    const routing = {
      supportsDomainProxy: true,
      registerRoute: async (route: RouteConfig) => {
        published.push(route);
      },
    };
    const registrar = createProjectRouteRegistrar({ id: "project" }, routing)!;
    const targets = [
      { targetUrl: "http://127.0.0.1:3000" },
      { targetUrl: "http://127.0.0.1:4000" },
      { staticRoot: "/tmp/example-static" },
      {
        proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://127.0.0.1:4000" }],
        pathsOnly: true,
      },
    ];
    for (const target of targets) {
      for (const domain of ["api.example.com", "events.example.com"]) {
        await registrar.registerRoute({
          domain,
          tls: true,
          ...target,
          proxy: { clientMaxBodySize: "99m" },
        } as RouteConfig);
      }
    }
    expect(published.map((route) => route.proxy?.clientMaxBodySize)).toEqual([
      "2m",
      "1m",
      "2m",
      "1m",
      "2m",
      "1m",
      "2m",
      "1m",
    ]);
    expect(published.every((route) => route.proxy?.proxyReadTimeout === "90s")).toBe(true);
    state.project.routingConfig.proxy.clientMaxBodySize = "3m";
    await registrar.registerRoute({ domain: "api.example.com", tls: false, ...targets[0] });
    await registrar.registerRoute({ domain: "events.example.com", tls: false, ...targets[0] });
    expect(published.slice(-2).map((route) => route.proxy?.clientMaxBodySize)).toEqual([
      "3m",
      "1m",
    ]);
    state.domains[1]!.proxy = null;
    await registrar.registerRoute({ domain: "events.example.com", tls: false, ...targets[0] });
    expect(published.at(-1)?.proxy?.clientMaxBodySize).toBe("3m");
  });

  it("refuses a saved override on a provider without the capability", async () => {
    const registerRoute = vi.fn();
    await expect(
      registerProjectRoute(
        { id: "project" },
        { registerRoute },
        { domain: "events.example.com", tls: false, targetUrl: "http://127.0.0.1:4000" },
      ),
    ).rejects.toThrow(/body.*limit.*supported/i);
    expect(registerRoute).not.toHaveBeenCalled();
  });
});
