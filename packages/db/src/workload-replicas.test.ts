import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./connection";
import { createEncryption } from "./encryption";
import { createRepositories } from "./repos/factory";
import { composeSpecsEqual, composeWritePatch, reconcileComposeSpec } from "./repos/service.repo";
import * as schema from "./schema";

describe("replica configuration persistence", () => {
  it("upgrades existing rows to one application instance and inherited service counts", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE TABLE project (id text PRIMARY KEY); CREATE TABLE service (id text PRIMARY KEY); INSERT INTO project VALUES ('old'); INSERT INTO service VALUES ('old');",
      );
      await db.exec(
        await readFile(new URL("../drizzle/0233_workload_replicas.sql", import.meta.url), "utf8"),
      );
      expect((await db.query("SELECT replicas FROM project")).rows).toEqual([{ replicas: 1 }]);
      expect((await db.query("SELECT replicas FROM service")).rows).toEqual([{ replicas: null }]);
      await expect(db.exec("UPDATE project SET replicas = 0")).rejects.toThrow();
      await expect(db.exec("UPDATE service SET replicas = 101")).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
  it("does not invent drift for legacy snapshots and preserves local edits in a three-way merge", () => {
    expect(composeSpecsEqual({ image: "api:one" }, { image: "api:one", replicas: null })).toBe(
      true,
    );
    expect(reconcileComposeSpec({ replicas: 3 }, { replicas: 2 }, { replicas: 4 }).replicas).toBe(
      3,
    );
    expect(reconcileComposeSpec({ replicas: 2 }, { replicas: 2 }, { replicas: 4 }).replicas).toBe(
      4,
    );
    expect(composeWritePatch({ name: "api", replicas: 2 }, { image: "api:one" }).replicas).toBe(2);
    expect(composeWritePatch({ name: "api" }, { image: "api:one" }).replicas).toBeNull();
  });
  it("rejects stale and foreign service writes under the configuration lock", async () => {
    const connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    const encryption = createEncryption("replica-configuration-test");
    try {
      const repos = createRepositories(connection.db, encryption);
      await connection.db.insert(schema.organization).values({ id: "org", name: "Test" });
      const group = await repos.projectGroup.create({
        organizationId: "org",
        name: "App",
        slug: "app",
      });
      const project = await repos.project.create({
        organizationId: "org",
        groupId: group.id,
        name: "App",
        slug: "app",
      });
      const other = await repos.project.create({
        organizationId: "org",
        groupId: group.id,
        name: "Other",
        slug: "other",
        environmentSlug: "other",
      });
      const service = await repos.service.create({
        projectId: project.id,
        name: "api",
        image: "app:stable",
      });
      const foreign = await repos.service.create({
        projectId: other.id,
        name: "api",
        image: "app:stable",
      });
      const request = {
        replicas: 3,
        expectedProjectUpdatedAt: project.updatedAt,
        expectedActiveDeploymentId: null,
      };
      expect(
        await repos.project.updateWorkloadReplicas(project.id, {
          ...request,
          serviceId: foreign.id,
          expectedServiceUpdatedAt: foreign.updatedAt,
        }),
      ).toBe(false);
      expect(
        await repos.project.updateWorkloadReplicas(project.id, {
          ...request,
          serviceId: service.id,
          expectedServiceUpdatedAt: new Date(0),
        }),
      ).toBe(false);
      expect(
        await repos.project.updateWorkloadReplicas(project.id, {
          ...request,
          serviceId: service.id,
          expectedServiceUpdatedAt: service.updatedAt,
        }),
      ).toBe(true);
      expect((await repos.service.findById(service.id))?.replicas).toBe(3);
      expect((await repos.service.findById(foreign.id))?.replicas).toBeNull();
      expect(await repos.project.updateWorkloadReplicas(project.id, request)).toBe(true);
      expect((await repos.project.findById(project.id))?.replicas).toBe(3);
      expect(
        await repos.project.updateWorkloadReplicas(project.id, { ...request, replicas: 4 }),
      ).toBe(false);
    } finally {
      await connection.close();
      encryption.close();
    }
  }, 30_000);
});
