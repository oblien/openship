import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { db, eq, repos, schema } from "@repo/db";
import { seedOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);
async function clients() {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "monorepo-create-test",
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
  return { owner, targets: [native, remote] };
}

describe("explicit monorepo creation through SDK/HTTP (#873)", () => {
  it("rejects an empty monorepo before persisting a project or group through create and ensure", async () => {
    const { owner, targets } = await clients();
    for (const [index, client] of targets.entries()) {
      const input = {
        name: `Empty mono ${index}`,
        projectType: "monorepo" as const,
        publicEndpoints: [],
      };
      await expect(client.projects.create(input)).rejects.toThrow(/requires detected app metadata/);
      await expect(client.projects.ensure(input)).rejects.toThrow(/requires detected app metadata/);
    }
    expect(
      await db.select().from(schema.project).where(eq(schema.project.organizationId, owner.orgId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.projectGroup)
        .where(eq(schema.projectGroup.organizationId, owner.orgId)),
    ).toEqual([]);
  });

  it("rejects duplicate app identities before writing any project", async () => {
    const { owner, targets } = await clients();
    for (const [index, client] of targets.entries()) {
      const input = {
        name: `Duplicate mono ${index}`,
        projectType: "monorepo" as const,
        monorepoApps: [
          { name: "web", rootDirectory: "apps/web" },
          { name: "web", rootDirectory: "other/web" },
        ],
      };
      await expect(client.projects.create(input)).rejects.toThrow(/unique name/);
      await expect(client.projects.ensure(input)).rejects.toThrow(/unique name/);
    }
    expect(
      await db.select().from(schema.project).where(eq(schema.project.organizationId, owner.orgId)),
    ).toEqual([]);
  });

  it("round-trips selection and app-owned domains without matching on a shared port", async () => {
    const { targets } = await clients();
    for (const [index, client] of targets.entries()) {
      const apps = ["api", "admin"].map((name) => ({
        name,
        rootDirectory: `apps/${name}`,
        framework: "node",
        port: 3000,
        enabled: name === "api",
        exposed: false,
        startCommand: "",
        environment: { MODE: "production" },
        publicEndpoints: [
          { port: 3000, customDomain: `${name}.example.com`, domainType: "custom" as const },
        ],
      }));
      const created = await client.projects.create({
        name: `Selected mono ${index}`,
        projectType: "monorepo",
        publicEndpoints: [],
        monorepoApps: apps,
      });
      await client.projects.ensure({
        projectId: created.id,
        name: `Selected mono ${index}`,
        projectType: "monorepo",
        monorepoApps: apps,
      });
      const rows = await repos.service.listByProject(created.id);
      expect(
        rows.map((row) => ({
          name: row.name,
          enabled: row.enabled,
          exposed: row.exposed,
          startCommand: row.startCommand,
          environment: row.environment,
          publicEndpoints: row.publicEndpoints,
        })),
      ).toEqual(
        apps.map(({ name, enabled, exposed, startCommand, environment, publicEndpoints }) => ({
          name,
          enabled,
          exposed,
          startCommand,
          environment,
          publicEndpoints,
        })),
      );
    }
  });

  it("retains supported multi-app creation when the detected app metadata is supplied", async () => {
    const { targets } = await clients();
    for (const [index, client] of targets.entries()) {
      const project = await client.projects.create({
        name: `Valid mono ${index}`,
        projectType: "monorepo",
        publicEndpoints: [],
        monorepoApps: [
          {
            name: "web",
            rootDirectory: "apps/web",
            framework: "nextjs",
            startCommand: "next start",
            exposed: false,
          },
          {
            name: "admin",
            rootDirectory: "apps/admin",
            framework: "nextjs",
            startCommand: "next start",
            exposed: false,
          },
        ],
      });
      expect((await client.projects.getInfo(project.id)).project).toMatchObject({
        projectType: "monorepo",
        serviceCount: 2,
      });
      expect((await repos.service.listByProject(project.id)).map((s) => s.name).sort()).toEqual([
        "admin",
        "web",
      ]);
    }
  });
});
