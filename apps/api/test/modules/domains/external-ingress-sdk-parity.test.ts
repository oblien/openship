import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { repos, seedOwner } from "../jobs/_harness";
import { seedProject } from "../../helpers/seed";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { domainRoutes } from "../../../src/modules/domains/domain.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const external = vi.hoisted(() => ({ dns: vi.fn(), certificate: vi.fn() }));
vi.mock("@repo/platform/engine/lib/platform-config", async (original) => ({
  ...(await original<object>()),
  platform: () => ({ target: "local" }),
}));
vi.mock("@repo/platform/engine/lib/dns-resolver", async (original) => ({
  ...(await original<object>()),
  resolveRecords: external.dns,
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", async (original) => ({
  ...(await original<object>()),
  provisionDomainCertForVerify: external.certificate,
}));
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/domains", domainRoutes);

// The existing self-hosted reverse-proxy mode is the answer to #706. Exercise
// the real shared operation and persisted ownership through both transports.
describe("self-hosted external ingress (#706)", () => {
  it("verifies an operator-owned private hostname without public DNS or local ACME", async () => {
    const owner = await seedOwner();
    const project = await seedProject(owner.orgId);
    const user = (await repos.user.findById(owner.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: {
        resolve: async () => ({
          user: { id: user.id, email: user.email, name: user.name },
          sessionId: "external-ingress-test",
        }),
      },
    });
    const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
    const remote = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
    for (const [index, client] of [native, remote].entries()) {
      const domain = await repos.domain.create({
        projectId: project.id,
        hostname: `private-${index}-${project.id}.invalid`,
        domainType: "custom",
        externalIngress: true,
      });
      expect(await client.domains.records(domain.id)).toEqual({ mode: "external", records: [] });
      expect(await client.domains.verify(domain.id)).toMatchObject({
        verified: true,
        sslStatus: "external",
      });
      expect(await repos.domain.findById(domain.id)).toMatchObject({
        verified: true,
        sslStatus: "external",
      });
    }
    expect(external.dns).not.toHaveBeenCalled();
    expect(external.certificate).not.toHaveBeenCalled();
  });

  it("does not let another organization verify the private domain", async () => {
    const owner = await seedOwner(),
      other = await seedOwner();
    const project = await seedProject(owner.orgId);
    const domain = await repos.domain.create({
      projectId: project.id,
      hostname: `foreign-${project.id}.invalid`,
      domainType: "custom",
      externalIngress: true,
    });
    const response = await app.request(`/api/domains/${domain.id}/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "x-organization-id": other.orgId },
    });
    expect(response.status).toBe(404);
    expect((await repos.domain.findById(domain.id))?.verified).toBe(false);
  });
});
