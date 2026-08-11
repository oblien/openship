import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      update: vi.fn(),
      updateSsl: vi.fn(),
      findOrCreate: vi.fn(),
    },
  },
}));

import {
  resolveStoredPublicEndpoints,
  syncStoredPublicEndpoints,
} from "../../src/lib/public-endpoints";
import { getRoutingBaseDomain } from "../../src/lib/routing-domains";

describe("public endpoint helpers", () => {
  it("uses the primary project custom domain when an explicit route target is provided", () => {
    const endpoints = resolveStoredPublicEndpoints({
      targetPath: "/",
      projectDomains: [{
        hostname: "app.example.com",
        isPrimary: true,
        verified: true,
        serviceId: null,
      } as any],
    });

    expect(endpoints).toEqual([{
      customDomain: "app.example.com",
      targetPath: "/",
      domainType: "custom",
    }]);
  });

  it("syncs the primary endpoint slug while preserving secondary endpoints", () => {
    const routing = syncStoredPublicEndpoints({
      current: [
        { port: 3000, domain: "my-app", domainType: "free" },
        { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
      ],
      slug: "renamed-app",
    });

    expect(routing.slug).toBe("renamed-app");
    expect(routing.publicEndpoints).toEqual([
      { port: 3000, domain: "renamed-app", domainType: "free" },
      { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
    ]);
  });

  it("prefers persisted route rows over legacy stored endpoints", () => {
    const endpoints = resolveStoredPublicEndpoints({
      stored: [{ port: 3000, domain: "legacy-app", domainType: "free" }],
      slug: "my-app",
      projectDomains: [
        {
          hostname: `my-app.${getRoutingBaseDomain()}`,
          isPrimary: true,
          verified: true,
          serviceId: null,
          targetPort: 3100,
          domainType: "free",
        },
        {
          hostname: "admin.example.com",
          isPrimary: false,
          verified: true,
          serviceId: null,
          targetPort: 4000,
          domainType: "custom",
        },
      ] as any,
    });

    expect(endpoints).toEqual([
      { port: 3100, domain: "my-app", domainType: "free" },
      { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
    ]);
  });

  it("requires an explicit route destination for default managed routes", () => {
    const endpoints = resolveStoredPublicEndpoints({
      slug: "my-app",
    });

    expect(endpoints).toEqual([]);
  });

  it("creates a default managed route when a target path is provided", () => {
    const endpoints = resolveStoredPublicEndpoints({
      slug: "my-app",
      targetPath: "/docs",
    });

    expect(endpoints).toEqual([
      { domain: "my-app", targetPath: "/docs", domainType: "free" },
    ]);
  });

  it("keeps an explicit free port endpoint by falling back to the project slug", () => {
    const routing = syncStoredPublicEndpoints({
      next: [{ port: 3200, domainType: "free" }],
      slug: "my-app",
    });

    expect(routing.slug).toBe("my-app");
    expect(routing.publicEndpoints).toEqual([
      { port: 3200, domain: "my-app", domainType: "free" },
    ]);
  });
});