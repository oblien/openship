import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, repos, schema, type Service } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import type { PlannedImportService } from "@repo/platform/engine/modules/migration/platform-import-plan";
import { platformImportRoutes } from "@repo/platform/engine/modules/migration/platform-import-project";
import { saveMigrationRoutes } from "@repo/platform/engine/modules/migration/migration-routes";
import { seedOrg, seedProject, seedService } from "../../helpers/seed";

const live = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("@repo/platform/engine/lib/route-apply.service", async (original) => ({
  ...(await original<object>()),
  reconcileProjectRoutes: live.reconcile,
}));

function recipe(
  service: Service,
  domains: PlannedImportService["source"]["domains"],
  data: PlannedImportService["data"] = "empty",
): PlannedImportService {
  return {
    source: {
      id: `source-${service.id}`,
      name: "Provider name",
      kind: "app",
      domains,
      env: {},
      rawEnv: {},
      variables: [],
      volumes: [],
      warnings: [],
      blockers: [],
    },
    data,
    create: { name: service.name },
    environment: {},
    bindings: [],
  };
}

describe("provider imports share native pending-domain persistence", () => {
  const organizations: string[] = [];
  let ctx: ExecutionContext;
  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = (await seedOrg()) as ExecutionContext;
    organizations.push(ctx.organizationId);
  });
  afterEach(async () => {
    for (const id of organizations.splice(0)) {
      await db.delete(schema.project).where(eq(schema.project.organizationId, id));
      await db.delete(schema.servers).where(eq(schema.servers.organizationId, id));
      await db.delete(schema.cloudWorkspace).where(eq(schema.cloudWorkspace.organizationId, id));
      await db.delete(schema.organization).where(eq(schema.organization.id, id));
    }
  });

  it.each(["server", "cloud"])(
    "saves custom aliases on their services without verifying or applying live routes (%s)",
    async (target) => {
      const managed =
        target === "cloud"
          ? await repos.cloudWorkspace.create({
              organizationId: ctx.organizationId,
              name: "Import destination",
            })
          : null;
      const server = managed
        ? await repos.server.findByWorkspace(managed.id, ctx.organizationId)
        : null;
      const project = await seedProject(ctx.organizationId, {
        framework: "docker-compose",
        serverId: server?.id,
      });
      const web = await seedService(project.id, {
        name: "storefront",
        ports: ["8080"],
        exposed: false,
      });
      const api = await seedService(project.id, {
        name: "api",
        kind: "monorepo",
        ports: ["3000"],
        exposed: false,
      });
      const internal = await seedService(project.id, {
        name: "worker",
        ports: ["9000"],
        exposed: false,
      });
      const plans = [
        recipe(web, [
          { hostname: "shop.example.com", portable: true },
          { hostname: "www.example.com", portable: true },
          { hostname: "shop.up.railway.app", portable: false },
        ]),
        recipe(api, [
          { hostname: "api.example.com", portable: true },
          { hostname: "api.vercel.app", portable: false },
        ]),
        recipe(internal, [{ hostname: "worker.up.railway.app", portable: false }]),
        recipe(internal, [{ hostname: "external.example.com", portable: true }], "external"),
      ];
      const routes = platformImportRoutes(plans);
      await saveMigrationRoutes(ctx, project.id, routes, () => {});
      // Re-saving uses the existing rows, including verification tokens and aliases.
      const original = await repos.domain.listByProject(project.id);
      await saveMigrationRoutes(ctx, project.id, routes, () => {});
      const domains = await repos.domain.listByProject(project.id);
      expect(domains.map((domain) => domain.id).sort()).toEqual(
        original.map((domain) => domain.id).sort(),
      );
      expect(domains).toHaveLength(3);
      for (const [hostname, serviceId, targetPort] of [
        ["shop.example.com", web.id, 8080],
        ["www.example.com", web.id, 8080],
        ["api.example.com", api.id, 3000],
      ] as const) {
        const domain = domains.find((item) => item.hostname === hostname)!;
        expect(domain).toMatchObject({
          projectId: project.id,
          serviceId,
          targetPort,
          verified: false,
          status: "pending",
        });
        expect(domain.verificationToken).toBeTruthy();
        expect(domain.verificationToken).toBe(
          original.find((item) => item.id === domain.id)?.verificationToken,
        );
      }
      expect((await repos.service.findById(web.id))?.publicEndpoints).toEqual([
        expect.objectContaining({ port: 8080, customDomain: "shop.example.com" }),
      ]);
      expect((await repos.project.findById(project.id))?.compositeRoutes).toEqual([
        expect.objectContaining({
          hostname: "www.example.com",
          rootServiceId: web.id,
          rootPort: 8080,
        }),
      ]);
      expect((await repos.service.findById(internal.id))?.exposed).toBe(false);
      expect(live.reconcile).not.toHaveBeenCalled();
    },
  );

  it("refuses a cross-organization domain before saving any imported route", async () => {
    const foreign = (await seedOrg()) as ExecutionContext;
    organizations.push(foreign.organizationId);
    const existingProject = await seedProject(foreign.organizationId, {
      framework: "docker-compose",
    });
    const existingService = await seedService(existingProject.id, {
      name: "owner",
      ports: ["8080"],
    });
    await saveMigrationRoutes(
      foreign,
      existingProject.id,
      platformImportRoutes([
        recipe(existingService, [{ hostname: "taken.example.com", portable: true }]),
      ]),
      () => {},
    );
    const original = await repos.domain.listByProject(existingProject.id);
    const project = await seedProject(ctx.organizationId, { framework: "docker-compose" });
    const web = await seedService(project.id, { name: "web", ports: ["8080"], exposed: false });
    await expect(
      saveMigrationRoutes(
        ctx,
        project.id,
        platformImportRoutes([
          recipe(web, [
            { hostname: "available.example.com", portable: true },
            { hostname: "taken.example.com", portable: true },
          ]),
        ]),
        () => {},
      ),
    ).rejects.toThrow("already connected to another project");
    expect(await repos.domain.listByProject(project.id)).toEqual([]);
    expect((await repos.service.findById(web.id))?.exposed).toBe(false);
    expect(await repos.domain.listByProject(existingProject.id)).toEqual(original);
    expect(live.reconcile).not.toHaveBeenCalled();
  });
});
