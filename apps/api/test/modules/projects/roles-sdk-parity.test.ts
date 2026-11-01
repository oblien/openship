import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { seedOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { buildConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);
async function setup() {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "roles-test",
      }),
    },
  });
  const clients = [
    await ship.scope({ identity: "verified", organizationId: owner.orgId }),
    new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }),
  ];
  return { clients, orgId: owner.orgId };
}
const clients = async () => (await setup()).clients;

const worker = {
  name: "jobs",
  kind: "worker",
  command: "bin/jobs",
  replicas: 2,
  stopGracePeriod: "90s",
} as const;
const scheduler = {
  name: "cron",
  kind: "scheduler",
  command: "bin/cron",
  health: { kind: "process" },
} as const;

const invalidRoles: Record<string, unknown>[] = [
  { name: "web", kind: "web", command: "bin/web" },
  { name: "jobs", kind: "worker", command: "bin/jobs", health: { kind: "http", path: "/up" } },
  { name: "jobs", kind: "worker", command: "bin/jobs", replicas: 2, singleton: true },
  { name: "jobs", kind: "worker", command: "bin/jobs", stopGracePeriod: "1m30" },
  { name: "Jobs_1", kind: "worker", command: "bin/jobs" },
];

describe("runtime roles through native SDK and HTTP", () => {
  it("persists roles, freezes them on snapshots, preserves omission and supports replacing and clearing", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const project = await client.projects.create({
        name: `Roles ${index}`,
        framework: "node",
        publicEndpoints: [],
        roles: [worker, scheduler],
      });
      // The scheduler is a singleton by definition; the parser makes that explicit.
      const expected = [worker, { ...scheduler, singleton: true }];
      expect(project.roles).toEqual(expected);
      const snapshot = buildConfigSnapshot((await repos.project.findById(project.id))!);
      expect(snapshot.roles).toEqual(expected);

      await client.projects.setOptions(project.id, { startCommand: "node app.js" });
      expect((await client.projects.get(project.id)).roles).toEqual(expected);

      await client.projects.setOptions(project.id, {
        roles: [{ name: "queue", kind: "worker", command: "bin/queue" }],
      });
      expect((await client.projects.get(project.id)).roles).toEqual([
        { name: "queue", kind: "worker", command: "bin/queue" },
      ]);
      expect(snapshot.roles).toEqual(expected);

      await client.projects.setOptions(project.id, { roles: [] });
      expect((await client.projects.get(project.id)).roles).toEqual([]);
      expect("roles" in buildConfigSnapshot((await repos.project.findById(project.id))!)).toBe(
        false,
      );

      await client.projects.setOptions(project.id, { roles: [worker] });
      await client.projects.setOptions(project.id, { roles: null });
      expect((await client.projects.get(project.id)).roles).toBeNull();
      expect("roles" in buildConfigSnapshot((await repos.project.findById(project.id))!)).toBe(
        false,
      );
    }
  });

  it("leaves a project created without roles NULL and out of its snapshot", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const project = await client.projects.create({
        name: `No roles ${index}`,
        publicEndpoints: [],
      });
      expect((await repos.project.findById(project.id))!.roles).toBeNull();
      expect("roles" in buildConfigSnapshot((await repos.project.findById(project.id))!)).toBe(
        false,
      );
    }
  });

  it("rejects an invalid role on update and on create, and persists nothing", async () => {
    const { clients, orgId } = await setup();
    for (const [index, client] of clients.entries()) {
      const project = await client.projects.create({
        name: `Roles validation ${index}`,
        publicEndpoints: [],
        roles: [worker],
      });
      const before = (await repos.project.listByOrganization(orgId, { perPage: 100 })).total;
      for (const role of invalidRoles) {
        await expect(
          client.projects.setOptions(project.id, { roles: [role] } as never),
        ).rejects.toThrow();
        expect((await repos.project.findById(project.id))!.roles).toEqual([worker]);
        await expect(
          client.projects.create({
            name: `Roles rejected ${index} ${String(role.name)} ${String(role.kind)}`,
            publicEndpoints: [],
            roles: [role],
          } as never),
        ).rejects.toThrow();
        expect((await repos.project.listByOrganization(orgId, { perPage: 100 })).total).toBe(
          before,
        );
      }
    }
  });

  it("ensure on an existing project replaces, preserves and validates roles", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const project = await client.projects.create({
        name: `Roles ensure ${index}`,
        framework: "node",
        publicEndpoints: [],
        roles: [worker],
      });
      const ensure = (extra: Record<string, unknown>) =>
        client.projects.ensure({
          name: `Roles ensure ${index}`,
          projectId: project.id,
          ...extra,
        } as never);
      const stored = async () => (await repos.project.findById(project.id))!.roles;

      const queue = { name: "queue", kind: "worker", command: "bin/queue" } as const;
      await ensure({ roles: [queue] });
      expect(await stored()).toEqual([queue]);

      // Omitting roles leaves them unchanged.
      await ensure({ startCommand: "node app.js" });
      expect(await stored()).toEqual([queue]);

      for (const role of invalidRoles) {
        await expect(ensure({ roles: [role] })).rejects.toThrow();
        expect(await stored()).toEqual([queue]);
      }

      await ensure({ roles: [] });
      expect(await stored()).toEqual([]);
      await ensure({ roles: null });
      expect(await stored()).toBeNull();
    }
  });

  it("imports openship.json roles from a local source while honoring explicit opt-outs", async () => {
    const source = await mkdtemp(join(tmpdir(), "openship-roles-import-"));
    try {
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ name: "demo", scripts: { start: "node app.js" } }),
      );
      await writeFile(
        join(source, "openship.json"),
        JSON.stringify({ roles: [{ name: "jobs", kind: "worker", command: "bin/jobs" }] }),
      );
      for (const [index, client] of (await clients()).entries()) {
        for (const [caseIndex, override] of [undefined, [], null].entries()) {
          const imported = await client.projects.importLocal({
            name: `Local roles ${index}-${caseIndex}`,
            localPath: source,
            publicEndpoints: [],
            ...(override !== undefined ? { roles: override } : {}),
          });
          expect(imported.roles).toEqual(
            override === undefined
              ? [{ name: "jobs", kind: "worker", command: "bin/jobs" }]
              : override,
          );
        }
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("keeps a declared empty roles list from openship.json as [] rather than dropping it", async () => {
    const source = await mkdtemp(join(tmpdir(), "openship-roles-empty-"));
    try {
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ name: "demo", scripts: { start: "node app.js" } }),
      );
      await writeFile(join(source, "openship.json"), JSON.stringify({ roles: [] }));
      for (const [index, client] of (await clients()).entries()) {
        const imported = await client.projects.importLocal({
          name: `Local empty roles ${index}`,
          localPath: source,
          publicEndpoints: [],
        });
        expect(imported.roles).toEqual([]);
        expect((await repos.project.findById(imported.id))!.roles).toEqual([]);
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});
