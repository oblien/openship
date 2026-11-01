import { describe, expect, it } from "vitest";
import { getAppEndpoints, getAppTemplate, type AppEndpoint } from "@repo/core";
import { defaultAppEndpointExposure, getAppEndpointModes } from "./app-endpoint-exposure";

const web: AppEndpoint = { service: "web", port: 3000, label: "Web", kind: "http" };

describe("app endpoint exposure defaults", () => {
  it.each([true, false])("gives every Convex web route a domain with Cloud connected=%s", (connected) => {
    const endpoints = getAppEndpoints(getAppTemplate("convex")!);
    expect(endpoints.map(({ service, port }) => [service, port])).toEqual([
      ["backend", 3210],
      ["backend", 3211],
      ["dashboard", 6791],
    ]);
    for (const endpoint of endpoints) {
      expect(defaultAppEndpointExposure(endpoint, connected)).toMatchObject({
        kind: "http",
        mode: "domain",
        ep: { domainType: connected ? "free" : "custom", port: String(endpoint.port) },
      });
    }
  });

  it("works for any public web endpoint without a template-specific rule", () => {
    expect(defaultAppEndpointExposure(web, true)).toMatchObject({
      kind: "http",
      mode: "domain",
      ep: { domainType: "free" },
    });
  });

  it("keeps a public web endpoint on domain routing without a Cloud connection", () => {
    expect(defaultAppEndpointExposure(web, false)).toMatchObject({
      kind: "http",
      mode: "domain",
      ep: { domainType: "custom" },
    });
  });

  it("keeps ClickHouse's authored domain, port-only and private defaults", () => {
    const endpoints = getAppEndpoints(getAppTemplate("clickhouse")!);
    expect(endpoints.map((endpoint) => defaultAppEndpointExposure(endpoint, true).mode)).toEqual([
      "domain",
      "port",
      "internal",
    ]);
    expect(defaultAppEndpointExposure(endpoints[0], false)).toMatchObject({
      mode: "domain",
      ep: { domainType: "custom" },
    });
  });

  it("gives Redis's browser UI a URL while keeping its database private", () => {
    const endpoints = getAppEndpoints(getAppTemplate("redis")!);
    expect(endpoints.map((endpoint) => defaultAppEndpointExposure(endpoint, true).mode)).toEqual([
      "domain",
      "internal",
    ]);
    expect(getAppEndpointModes(endpoints[1])).toEqual(["internal"]);
  });

  it.each([true, false])("keeps database ports private with Cloud connected=%s", (connected) => {
    for (const appId of ["mongodb", "umami", "supabase"]) {
      const endpoints = getAppEndpoints(getAppTemplate(appId)!);
      expect(endpoints.map((endpoint) => defaultAppEndpointExposure(endpoint, connected).mode))
        .toEqual(["domain", "internal"]);
    }
  });

  it("allows templates to explicitly publish a raw TCP endpoint", () => {
    const tcp: AppEndpoint = { ...web, kind: "tcp" };
    expect(defaultAppEndpointExposure(tcp, false)).toEqual({ kind: "tcp", mode: "internal" });
    expect(defaultAppEndpointExposure({ ...tcp, scope: "public" }, false))
      .toEqual({ kind: "tcp", mode: "publish" });
    expect(defaultAppEndpointExposure({ ...tcp, defaultMode: "publish" }, false))
      .toEqual({ kind: "tcp", mode: "publish" });
  });

  it.each(["internal", "local"] as const)(
    "respects %s reachability without an explicit mode",
    (scope) => {
      expect(defaultAppEndpointExposure({ ...web, scope }, true).mode).toBe("port");
      expect(defaultAppEndpointExposure({ ...web, kind: "tcp", scope }, true)).toEqual({
        kind: "tcp",
        mode: "internal",
      });
    },
  );

  it("selects only an allowed mode, even when a template's default conflicts", () => {
    expect(
      defaultAppEndpointExposure({ ...web, defaultMode: "domain", allowedModes: ["port"] }, true)
        .mode,
    ).toBe("port");
    expect(defaultAppEndpointExposure({ ...web, allowedModes: ["domain"] }, false)).toMatchObject({
      mode: "domain",
      ep: { domainType: "custom" },
    });
    expect(
      defaultAppEndpointExposure(
        { ...web, kind: "tcp", defaultMode: "publish", allowedModes: ["internal"] },
        true,
      ),
    ).toEqual({ kind: "tcp", mode: "internal" });
  });

  it("never offers another protocol's modes", () => {
    expect(getAppEndpointModes({ ...web, allowedModes: ["domain", "publish"] })).toEqual([
      "domain",
    ]);
    expect(
      getAppEndpointModes({ ...web, kind: "tcp", allowedModes: ["domain", "internal"] }),
    ).toEqual(["internal"]);
  });
});
