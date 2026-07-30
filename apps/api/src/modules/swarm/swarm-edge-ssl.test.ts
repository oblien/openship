import { describe, expect, it, vi } from "vitest";
import type { Domain, Project, Service, SwarmStack } from "@repo/db";
import { createSwarmEdgeSslProvider, resolveSwarmEdgeSslProvider } from "./swarm-edge-ssl";

describe("Swarm Edge SSL provider", () => {
  it("issues only after registering its fixed HTTP route, then reports the inspected certificate", async () => {
    const edge = {
      register: vi.fn(async () => {}),
      provisionTls: vi.fn(async () => ({ domain: "app.example.test", expiresAt: "2026-10-28T12:00:00.000Z", verified: true })),
      certificateStatus: vi.fn(async () => ({ domain: "app.example.test", expiresAt: "", verified: false })),
    };
    const ssl = createSwarmEdgeSslProvider(
      { domain: "app.example.test", serviceDnsName: "blog_web", port: 3000 },
      edge,
    );

    await expect(ssl.provisionCert("app.example.test")).resolves.toMatchObject({
      verified: true,
      issuer: "letsencrypt",
      reason: "issued",
    });
    expect(edge.register).toHaveBeenCalledWith(
      { domain: "app.example.test", serviceDnsName: "blog_web", port: 3000 },
      { tls: false },
    );
    await expect(ssl.provisionCert("other.example.test")).rejects.toMatchObject({ code: "SWARM_EDGE_DOMAIN_MISMATCH" });
  });

  it("resolves a domain only through its owned, exposed Swarm service endpoint", async () => {
    const edge = {
      register: vi.fn(async () => {}),
      provisionTls: vi.fn(async () => ({ domain: "app.example.test", expiresAt: "", verified: false })),
      certificateStatus: vi.fn(async () => ({ domain: "app.example.test", expiresAt: "", verified: false })),
    };
    const provider = await resolveSwarmEdgeSslProvider(
      { id: "project-a", organizationId: "org-a" } as Project,
      { hostname: "app.example.test", serviceId: "service-web" } as Domain,
      {
        getStack: async () => ({
          managerServerId: "server-manager",
          managementMode: "managed",
          routingMode: "openship-edge",
          stackName: "blog",
        }) as SwarmStack,
        getService: async () => ({
          id: "service-web",
          projectId: "project-a",
          kind: "swarm",
          sourceServiceName: "web",
          enabled: true,
          exposed: true,
          exposedPort: "3000",
          domainType: "custom",
          customDomain: "app.example.test",
          publicEndpoints: [],
        }) as unknown as Service,
        resolvePlatform: async () => ({}) as never,
        createManager: () => edge as never,
      },
    );

    await provider.provisionCert("app.example.test");
    expect(edge.register).toHaveBeenCalledWith(
      { domain: "app.example.test", serviceDnsName: "blog_web", port: 3000 },
      { tls: false },
    );
  });
});
