import { describe, it, expect } from "vitest";
import { buildDomainFanoutRegistrations } from "@repo/platform/engine/modules/deployments/compose/composite-route";
import type { ProjectCompositeRoute } from "@repo/core";

const onvo: ProjectCompositeRoute = {
  hostname: "api.onvo.me",
  isCustomDomain: true,
  rootServiceId: "svc-web",
  locations: [{ pathPrefix: "/v3", serviceId: "svc-api" }],
};

const upstreams: Record<string, string> = {
  "svc-web": "http://10.0.0.1:1010",
  "svc-api": "http://10.0.0.2:1020",
};

describe("buildDomainFanoutRegistrations", () => {
  it("emits one register per domain: root at / + a proxyLocation for each extra path", () => {
    const regs = buildDomainFanoutRegistrations({
      routes: [onvo],
      resolveTargetUrl: (id) => upstreams[id],
    });
    expect(regs).toEqual([
      {
        hostname: "api.onvo.me",
        isCustomDomain: true,
        targetUrl: "http://10.0.0.1:1010",
        proxyLocations: [{ pathPrefix: "/v3", targetUrl: "http://10.0.0.2:1020" }],
      },
    ]);
  });

  it("preserves exact-match locations in the generated registration", () => {
    const exact: ProjectCompositeRoute = {
      ...onvo,
      locations: [{ pathPrefix: "/mcp", serviceId: "svc-api", exact: true }],
    };
    const regs = buildDomainFanoutRegistrations({
      routes: [exact],
      resolveTargetUrl: (id) => upstreams[id],
    });

    expect(regs[0].proxyLocations).toEqual([
      { pathPrefix: "/mcp", targetUrl: "http://10.0.0.2:1020", exact: true },
    ]);
  });

  it("skips the whole domain when the ROOT upstream can't resolve", () => {
    const regs = buildDomainFanoutRegistrations({
      routes: [onvo],
      resolveTargetUrl: (id) => (id === "svc-web" ? null : upstreams[id]),
    });
    expect(regs).toEqual([]);
  });

  it("keeps the previous domain route when a path upstream cannot resolve", () => {
    const regs = buildDomainFanoutRegistrations({
      routes: [onvo],
      resolveTargetUrl: (id) => (id === "svc-api" ? null : upstreams[id]),
    });
    expect(regs).toEqual([]);
  });

  it("is a no-op for null / empty routes", () => {
    expect(buildDomainFanoutRegistrations({ routes: null, resolveTargetUrl: () => null })).toEqual([]);
    expect(buildDomainFanoutRegistrations({ routes: [], resolveTargetUrl: () => "x" })).toEqual([]);
  });

  it("preserves a path-only table and refuses to replace it if any upstream is missing", () => {
    const route: ProjectCompositeRoute = {
      hostname: "api.onvo.me",
      isCustomDomain: true,
      locations: [
        { pathPrefix: "/v3", serviceId: "svc-api" },
        { pathPrefix: "/mcp", serviceId: "svc-web", exact: true },
      ],
    };
    expect(buildDomainFanoutRegistrations({
      routes: [route],
      resolveTargetUrl: (id) => upstreams[id],
    })[0]).toMatchObject({ notFound: true, proxyLocations: [
      { pathPrefix: "/v3", targetUrl: upstreams["svc-api"] },
      { pathPrefix: "/mcp", targetUrl: upstreams["svc-web"], exact: true },
    ] });
    expect(buildDomainFanoutRegistrations({
      routes: [route],
      resolveTargetUrl: (id) => id === "svc-api" ? upstreams[id] : null,
    })).toEqual([]);
    expect(buildDomainFanoutRegistrations({
      routes: [route],
      services: [],
      domainByHostname: new Map(),
      resolveTargetUrl: (id) => upstreams[id],
    })).toEqual([]);
  });
});
