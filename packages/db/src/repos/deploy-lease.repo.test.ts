import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { deployment, project } from "../schema";
import { createDeploymentRepo } from "./deployment.repo";
import { createProjectRepo } from "./project.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function fresh() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(project).values({
    id: "p1",
    organizationId: "org1",
    groupId: "g1",
    name: "app",
    slug: "app",
  });
  await db.insert(deployment).values({
    id: "d1",
    projectId: "p1",
    organizationId: "org1",
    status: "building",
    branch: "main",
  });
  return {
    db,
    projects: createProjectRepo(db),
    deployments: createDeploymentRepo(db),
  };
}

describe("deploy lease CAS", () => {
  it("lets only one deployment claim the project lease", async () => {
    const { db, projects } = await fresh();

    const [first, second] = await Promise.all([
      projects.claimDeployLease("p1", "d1"),
      projects.claimDeployLease("p1", "d2"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const row = await db.query.project.findFirst({ where: eq(project.id, "p1") });
    expect(row?.deployLeaseId === "d1" || row?.deployLeaseId === "d2").toBe(true);
  });

  it("does not release the lease for a different deployment", async () => {
    const { db, projects } = await fresh();
    expect(await projects.claimDeployLease("p1", "d1")).toBe(true);

    expect(await projects.releaseDeployLease("p1", "d-other")).toBe(false);
    const held = await db.query.project.findFirst({ where: eq(project.id, "p1") });
    expect(held?.deployLeaseId).toBe("d1");

    expect(await projects.releaseDeployLease("p1", "d1")).toBe(true);
    expect(await projects.claimDeployLease("p1", "d2")).toBe(true);
  });

  it("refuses a phase write after cancel", async () => {
    const { deployments } = await fresh();
    expect(await deployments.setReleasePhase("d1", "fetching")).toBe(true);
    expect(await deployments.updateStatus("d1", "cancelled")).toBe(true);
    expect(await deployments.setReleasePhase("d1", "activating")).toBe(false);
    expect(await deployments.updateStatus("d1", "ready")).toBe(false);
  });

  it("persists incremental build-session logs", async () => {
    const { db, deployments } = await fresh();
    const session = await deployments.createBuildSession({
      deploymentId: "d1",
      projectId: "p1",
      status: "building",
    });
    await deployments.persistBuildSessionLogs(session.id, [
      { timestamp: "t", message: "fetching", level: "info" },
    ]);
    const row = await db.query.buildSession.findFirst({
      where: eq(schema.buildSession.id, session.id),
    });
    expect(row?.logs).toEqual([{ timestamp: "t", message: "fetching", level: "info" }]);
  });
});
