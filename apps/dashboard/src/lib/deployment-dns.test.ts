import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { deploymentDnsTargets } from "./deployment-dns";

const endpoint = (customDomain: string) => ({
  id: customDomain,
  port: "3000",
  targetPath: "",
  domain: "",
  customDomain,
  domainType: "custom" as const,
});

describe("deploymentDnsTargets", () => {
  it("finds a Docker single-app custom domain", () => {
    expect(deploymentDnsTargets({ publicEndpoints: [endpoint("app.example.com")], services: [] }))
      .toEqual([{ hostname: "app.example.com", includeWww: false }]);
  });

  it("finds scalar and multi-route Docker Compose domains (#663)", () => {
    expect(deploymentDnsTargets({
      publicEndpoints: [],
      services: [
        {
          name: "web",
          ports: ["3000:3000"],
          dependsOn: [],
          environment: {},
          volumes: [],
          exposed: true,
          domainType: "custom",
          customDomain: "web.example.com",
        },
        {
          name: "admin",
          ports: ["4000:4000", "4001:4001"],
          dependsOn: [],
          environment: {},
          volumes: [],
          exposed: true,
          publicEndpoints: [endpoint("admin.example.com"), endpoint("metrics.example.com")],
        },
      ],
    } as never)).toEqual([
      { hostname: "web.example.com", includeWww: false },
      { hostname: "admin.example.com", includeWww: false },
      { hostname: "metrics.example.com", includeWww: false },
    ]);
  });

  it("ignores non-custom and unexposed Compose routes", () => {
    expect(deploymentDnsTargets({
      publicEndpoints: [],
      services: [
        {
          name: "private",
          exposed: false,
          domainType: "custom",
          customDomain: "private.example.com",
        },
        { name: "free", exposed: true, domainType: "free", domain: "free" },
      ],
    } as never)).toEqual([]);
  });

  it("groups www with its apex but preserves a standalone www hostname", () => {
    expect(deploymentDnsTargets({
      publicEndpoints: [endpoint("example.com"), endpoint("www.example.com")],
      services: [],
    })).toEqual([{ hostname: "example.com", includeWww: true }]);

    expect(deploymentDnsTargets({
      publicEndpoints: [endpoint("www.only.example.com")],
      services: [],
    })).toEqual([{ hostname: "www.only.example.com", includeWww: false }]);
  });

  it("normalizes and deduplicates hostnames across project and service routes", () => {
    expect(deploymentDnsTargets({
      publicEndpoints: [endpoint("HTTPS://App.Example.com/")],
      services: [{
        name: "web",
        exposed: true,
        domainType: "custom",
        customDomain: "app.example.com",
      }],
    } as never)).toEqual([{ hostname: "app.example.com", includeWww: false }]);
  });

  it("is the source used by the Deploy-click DNS gate", () => {
    const sidebar = readFileSync(
      new URL("../app/(dashboard)/(deployment)/deploy/[slug]/components/Sidebar.tsx", import.meta.url),
      "utf8",
    );
    expect(sidebar).toContain("deploymentDnsTargets(config)");
    expect(sidebar).toContain("<DnsRecordsModal");
    expect(sidebar).toContain("targets={dnsTargets}");
  });
});
