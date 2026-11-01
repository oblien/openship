import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo, type DeploymentRoleChanges } from "./deployment.repo";
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDeploymentRepo(db, createEncryption("role-configuration-tests"));
const stamp = new Date("2026-10-17T00:00:00Z");
const deploy = {
  projectId: "project",
  organizationId: "org",
  branch: "main",
  trigger: "configuration",
  status: "queued",
};
const change = (): DeploymentRoleChanges => ({
  expectedActiveDeploymentId: "active",
  expectedProjectUpdatedAt: stamp,
  roles: [{ name: "queue", kind: "worker", command: "exec worker", replicas: 3 }],
});
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica");
});
afterAll(() => client.close());
beforeEach(async () => {
  await client.exec("TRUNCATE build_session, deployment, project CASCADE");
  await db.insert(schema.project).values({
    id: "project",
    organizationId: "org",
    groupId: "group",
    name: "App",
    slug: "app",
    activeDeploymentId: "active",
    updatedAt: stamp,
  });
  await db.insert(schema.deployment).values({
    id: "active",
    projectId: "project",
    organizationId: "org",
    branch: "main",
    status: "ready",
  });
});
describe("atomic runtime role configuration admission", () => {
  it("commits desired roles, the immutable deployment and its queue entry together", async () => {
    const dep = await repo.create(deploy, undefined, undefined, change());
    expect(dep?.trigger).toBe("configuration");
    expect((await db.select().from(schema.project))[0].roles).toEqual(change().roles);
    expect(await repo.findBuildSessionByDeploymentId(dep!.id)).toMatchObject({ status: "queued" });
  });
  it("rolls back every write when the project revision changed", async () => {
    await db
      .update(schema.project)
      .set({ updatedAt: new Date(stamp.getTime() + 1) })
      .where(eq(schema.project.id, "project"));
    await expect(repo.create(deploy, undefined, undefined, change())).rejects.toMatchObject({
      code: "ROLE_CONFIGURATION_CHANGED",
    });
    expect((await db.select().from(schema.deployment)).map((row) => row.id)).toEqual(["active"]);
    expect(await db.select().from(schema.buildSession)).toEqual([]);
    expect((await db.select().from(schema.project))[0].roles).toBeNull();
  });
  it("does not overwrite desired roles when another deployment already owns admission", async () => {
    await repo.create(deploy);
    expect(await repo.create(deploy, undefined, undefined, change())).toBeUndefined();
    expect((await db.select().from(schema.project))[0].roles).toBeNull();
  });
});
