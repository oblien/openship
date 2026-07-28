import { describe, it, expect } from "vitest";
import { buildDomainFanoutRegistrations } from "./composite-route";
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

  it("skips the whole domain when the ROOT upstream can't resolve", () => {
    const regs = buildDomainFanoutRegistrations({
      routes: [onvo],
      resolveTargetUrl: (id) => (id === "svc-web" ? null : upstreams[id]),
    });
    expect(regs).toEqual([]);
  });

  it("drops only the unresolvable path location, keeps the domain on its root", () => {
    const regs = buildDomainFanoutRegistrations({
      routes: [onvo],
      resolveTargetUrl: (id) => (id === "svc-api" ? null : upstreams[id]),
    });
    expect(regs).toEqual([
      { hostname: "api.onvo.me", isCustomDomain: true, targetUrl: "http://10.0.0.1:1010" },
    ]);
  });

  it("is a no-op for null / empty routes", () => {
    expect(buildDomainFanoutRegistrations({ routes: null, resolveTargetUrl: () => null })).toEqual([]);
    expect(buildDomainFanoutRegistrations({ routes: [], resolveTargetUrl: () => "x" })).toEqual([]);
  });
});
