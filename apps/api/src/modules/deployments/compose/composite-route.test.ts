import { describe, it, expect } from "vitest";
import { buildCompositeRegistration, buildDomainFanoutRegistrations } from "./composite-route";
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

  it("carries the canonical redirect into a redeployed fanout vhost", () => {
    const regs = buildDomainFanoutRegistrations({
      routes: [onvo],
      resolveTargetUrl: (id) => upstreams[id],
      resolveRedirectHost: () => ({ target: "onvo.me", statusCode: 308 }),
    });

    expect(regs[0].redirectHost).toEqual({ target: "onvo.me", statusCode: 308 });
  });
});

describe("buildCompositeRegistration canonical redirect", () => {
  it("carries the canonical redirect into a redeployed composite vhost", () => {
    const registration = buildCompositeRegistration({
      services: [
        {
          id: "web",
          name: "web",
          kind: "monorepo",
          framework: "vite",
          startCommand: "",
          enabled: true,
        },
        {
          id: "api",
          name: "api",
          kind: "monorepo",
          framework: "express",
          startCommand: "npm start",
          enabled: true,
        },
      ],
      resolveTargetUrl: (id) => id === "api" ? "http://10.0.0.2:3000" : null,
      resolveStaticRoot: (id) => id === "web" ? "/opt/openship/static/web" : null,
      resolveDomain: () => ({ hostname: "www.example.com", isCustomDomain: true }),
      resolveRedirectHost: () => ({ target: "example.com", statusCode: 301 }),
    });

    expect(registration?.register).toMatchObject({
      hostname: "www.example.com",
      redirectHost: { target: "example.com", statusCode: 301 },
    });
  });
});
