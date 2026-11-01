import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, repos, schema, type Service } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { seedOrg, seedProject, seedService } from "../../helpers/seed";
import { saveMigrationRoutes } from "@repo/platform/engine/modules/migration/migration-routes";
import { updateService } from "@repo/platform/engine/modules/services/service.service";
import { removeDomain } from "@repo/platform/engine/modules/domains/domain.service";
import { buildServiceRouteDomains } from "@repo/platform/engine/lib/routing-domains";
import { buildDomainFanoutRegistrations } from "@repo/platform/engine/modules/deployments/compose/composite-route";

// This suite exercises persisted state. The real SSH edge removal is covered by
// migration-takeover.e2e.test.ts, without replacing its network boundary.
vi.mock("@repo/platform/engine/lib/route-apply.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  reconcileProjectRoutes: vi.fn(),
}));

describe("persisted migration routing through service edits and deletion", () => {
  let ctx: ExecutionContext;
  let projectId: string;
  let web: Service;
  let api: Service;
  beforeEach(async () => {
    ctx = (await seedOrg()) as ExecutionContext;
    const project = await seedProject(ctx.organizationId, { projectType: "services" });
    projectId = project.id;
    web = await seedService(projectId, { name: "frontend", ports: ["8080", "8081"] });
    api = await seedService(projectId, { name: "backend", ports: ["9000"] });
    await saveMigrationRoutes(
      ctx,
      projectId,
      {
        frontend: [
          { domainType: "custom", customDomain: "shop.example.com", exposedPort: "8080" },
          { domainType: "custom", customDomain: "www.example.com", exposedPort: "8080" },
          { domainType: "custom", customDomain: "admin.example.com", exposedPort: "8081" },
        ],
        backend: [
          {
            domainType: "custom",
            customDomain: "shop.example.com",
            exposedPort: "9000",
            targetPath: "/api",
          },
        ],
      },
      () => {},
    );
  }, 30_000);
  afterEach(async () => {
    if (ctx)
      await db.delete(schema.organization).where(eq(schema.organization.id, ctx.organizationId));
  });

  async function render() {
    const project = (await repos.project.findById(projectId))!;
    const services = await repos.service.listByProject(projectId);
    const domainByHostname = new Map(
      (await repos.domain.listByProject(projectId)).map((domain) => [domain.hostname, domain]),
    );
    return {
      base: services.flatMap((service) =>
        buildServiceRouteDomains({
          project,
          service,
          runtimeName: "docker",
          usesManagedRouting: false,
          domainByHostname,
        }),
      ),
      topology: buildDomainFanoutRegistrations({
        routes: project.compositeRoutes,
        services,
        domainByHostname,
        resolveTargetUrl: (id, port) => `http://${id}:${port}`,
      }),
    };
  }

  it("owns every hostname and uses the canonical service planner for aliases and distinct ports", async () => {
    const domains = await repos.domain.listByProject(projectId);
    expect(
      domains.map((domain) => [domain.hostname, domain.serviceId, domain.targetPort]).sort(),
    ).toEqual([
      ["admin.example.com", web.id, 8081],
      ["shop.example.com", web.id, 8080],
      ["www.example.com", web.id, 8080],
    ]);
    expect(domains.every((domain) => !domain.verified)).toBe(true);
    const { base, topology } = await render();
    expect(base.map((route) => [route.hostname, route.targetPort]).sort()).toEqual([
      ["admin.example.com", 8081],
      ["shop.example.com", 8080],
      ["www.example.com", 8080],
    ]);
    expect(topology.find((route) => route.hostname === "shop.example.com")?.proxyLocations).toEqual(
      [{ pathPrefix: "/api", targetUrl: `http://${api.id}:9000` }],
    );
  });

  it("does not restore an old root port or unexposed routes when the service is edited", async () => {
    await updateService(
      ctx,
      projectId,
      web.id,
      {
        publicEndpoints: [
          { domainType: "custom", customDomain: "shop.example.com", port: 8090 },
          { domainType: "custom", customDomain: "admin.example.com", port: 8081 },
        ],
      },
      { applyLiveRoutes: false },
    );
    expect(
      (await render()).topology.find((route) => route.hostname === "shop.example.com")?.targetUrl,
    ).toBe(`http://${web.id}:8090`);
    await updateService(ctx, projectId, web.id, { exposed: false }, { applyLiveRoutes: false });
    expect(await render()).toEqual({ base: [], topology: [] });
  });

  it("removes aliases with their domain row, and clears stale service references", async () => {
    const domains = await repos.domain.listByProject(projectId);
    await repos.domain.removeWithServiceRouting(
      domains.find((domain) => domain.hostname === "www.example.com")!.id,
      {
        serviceId: web.id,
        routing: { exposed: true },
      },
    );
    const rendered = await render();
    expect(
      [...rendered.base, ...rendered.topology].some(
        (route) => route.hostname === "www.example.com",
      ),
    ).toBe(false);
    expect(
      rendered.topology.find((route) => route.hostname === "shop.example.com")?.proxyLocations,
    ).toHaveLength(1);
    await repos.service.remove(api.id);
    expect(
      (await render()).topology.find((route) => route.hostname === "shop.example.com")
        ?.proxyLocations,
    ).toBeUndefined();
    await repos.domain.remove(domains.find((domain) => domain.hostname === "shop.example.com")!.id);
    expect((await repos.project.findById(projectId))?.compositeRoutes).toEqual([]);
  });

  it("promotes the surviving alias when its primary hostname is removed", async () => {
    const domains = await repos.domain.listByProject(projectId);
    await removeDomain(ctx, domains.find((domain) => domain.hostname === "shop.example.com")!.id);
    const updated = (await repos.service.findById(web.id))!;
    expect(updated.exposed).toBe(true);
    expect(updated.publicEndpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customDomain: "www.example.com", port: 8080 }),
        expect.objectContaining({ customDomain: "admin.example.com", port: 8081 }),
      ]),
    );
    expect((await render()).base.map((route) => route.hostname).sort()).toEqual([
      "admin.example.com",
      "www.example.com",
    ]);
    await removeDomain(ctx, domains.find((domain) => domain.hostname === "www.example.com")!.id);
    expect((await render()).base.map((route) => route.hostname)).toEqual(["admin.example.com"]);
  });

  it("keeps the edited primary port when an alias is removed", async () => {
    await updateService(
      ctx,
      projectId,
      web.id,
      {
        publicEndpoints: [
          { domainType: "custom", customDomain: "shop.example.com", port: 8090 },
          { domainType: "custom", customDomain: "admin.example.com", port: 8081 },
        ],
      },
      { applyLiveRoutes: false },
    );
    const alias = (await repos.domain.listByProject(projectId)).find(
      (domain) => domain.hostname === "www.example.com",
    )!;
    await removeDomain(ctx, alias.id);
    expect((await repos.service.findById(web.id))!.publicEndpoints).toEqual([
      { domainType: "custom", customDomain: "shop.example.com", port: 8090 },
      { domainType: "custom", customDomain: "admin.example.com", port: 8081 },
    ]);
    expect(
      (await render()).topology.find((route) => route.hostname === "shop.example.com")?.targetUrl,
    ).toBe(`http://${web.id}:8090`);
  });

  it("rejects a hostname owned by another project before changing earlier services", async () => {
    const other = await seedProject(ctx.organizationId);
    await repos.domain.create({
      projectId: other.id,
      hostname: "taken.example.com",
      verificationToken: "test",
    });
    const before = await repos.service.findById(web.id);
    const topology = (await repos.project.findById(projectId))?.compositeRoutes;
    await expect(
      saveMigrationRoutes(
        ctx,
        projectId,
        {
          frontend: {
            domainType: "custom",
            customDomain: "replacement.example.com",
            exposedPort: "8081",
          },
          backend: { domainType: "custom", customDomain: "taken.example.com", exposedPort: "9000" },
        },
        () => {},
      ),
    ).rejects.toThrow(/already connected to another project/);
    expect(await repos.service.findById(web.id)).toEqual(before);
    expect((await repos.project.findById(projectId))?.compositeRoutes).toEqual(topology);
    expect(await repos.domain.findByHostname("replacement.example.com")).toBeUndefined();
  });

  it("persists path-only routes on the project and re-renders them after service edits", async () => {
    await saveMigrationRoutes(ctx, projectId, {
      backend: [
        { domainType: "custom", customDomain: "api.onvo.me", exposedPort: "9000", targetPath: "/v3" },
        { domainType: "custom", customDomain: "api.onvo.me", exposedPort: "9000", targetPath: "/mcp", exact: true },
      ],
    }, () => {});
    const domain = await repos.domain.findByHostname("api.onvo.me");
    expect(domain).toMatchObject({ projectId, serviceId: null, targetPort: null, verified: false });
    expect((await render()).base.some(route => route.hostname === "api.onvo.me")).toBe(false);
    const expected = {
      hostname: "api.onvo.me",
      isCustomDomain: true,
      notFound: true,
      proxyLocations: [
        { pathPrefix: "/v3", targetUrl: `http://${api.id}:9000` },
        { pathPrefix: "/mcp", targetUrl: `http://${api.id}:9000`, exact: true },
      ],
    };
    expect((await render()).topology.find(route => route.hostname === "api.onvo.me")).toEqual(expected);
    await updateService(ctx, projectId, api.id, { ports: ["9000", "9100"] }, { applyLiveRoutes: false });
    expect((await render()).topology.find(route => route.hostname === "api.onvo.me")).toEqual(expected);
    await repos.domain.remove(domain!.id);
    expect((await render()).topology.some(route => route.hostname === "api.onvo.me")).toBe(false);
  });
});
