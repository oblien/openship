import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function freshRepo(deletionInProgress: boolean) {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.project).values({
    id: "p1",
    organizationId: "org1",
    groupId: "g1",
    name: "app",
    slug: "app",
    deletionInProgress,
  });
  return { db, repo: createDeploymentRepo(db) };
}

describe("deployment creation vs. project deletion", () => {
  it("creates while the project is live", async () => {
    const { repo } = await freshRepo(false);

    const deployment = await repo.create({
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      status: "queued",
    });

    expect(deployment?.projectId).toBe("p1");
  });

  it("refuses to enqueue after deletion has claimed the project", async () => {
    const { repo } = await freshRepo(true);

    const deployment = await repo.create({
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      status: "queued",
    });

    expect(deployment).toBeUndefined();
  });

  it("refuses an organization-mismatched deployment at the same barrier", async () => {
    const { repo } = await freshRepo(false);

    const deployment = await repo.create({
      projectId: "p1",
      organizationId: "org2",
      branch: "main",
      status: "queued",
    });

    expect(deployment).toBeUndefined();
  });

  it("atomically claims one queued worker while the project is live", async () => {
    const { repo } = await freshRepo(false);
    const deployment = await repo.create({
      id: "dep1",
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      status: "queued",
    });
    expect(deployment).toBeDefined();
    await repo.createBuildSession({
      deploymentId: "dep1",
      projectId: "p1",
      status: "queued",
    });
    const session = await repo.findBuildSessionByDeploymentId("dep1");
    expect(session).toBeDefined();

    await expect(
      repo.claimBuildExecution({
        deploymentId: "dep1",
        buildSessionId: session!.id,
        projectId: "p1",
        organizationId: "org1",
      }),
    ).resolves.toBe("claimed");
    await expect(
      repo.claimBuildExecution({
        deploymentId: "dep1",
        buildSessionId: session!.id,
        projectId: "p1",
        organizationId: "org1",
      }),
    ).resolves.toBe("state_changed");
  });

  it("refuses kickoff after deletion wins the gap following deployment creation", async () => {
    const { db, repo } = await freshRepo(false);
    await repo.create({
      id: "dep1",
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      status: "queued",
    });
    await repo.createBuildSession({
      deploymentId: "dep1",
      projectId: "p1",
      status: "queued",
    });
    const session = await repo.findBuildSessionByDeploymentId("dep1");
    await db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(
      repo.claimBuildExecution({
        deploymentId: "dep1",
        buildSessionId: session!.id,
        projectId: "p1",
        organizationId: "org1",
      }),
    ).resolves.toBe("project_unavailable");

    await expect(
      repo.cancelUnclaimedBuild({
        deploymentId: "dep1",
        buildSessionId: session!.id,
        projectId: "p1",
      }),
    ).resolves.toBe(true);
    expect(await repo.findById("dep1")).toMatchObject({ status: "cancelled" });
    expect(await repo.listInFlightByProject("p1")).toEqual([]);
  });

  it("keeps a cancelled deployment active until its worker acknowledges completion", async () => {
    const { repo } = await freshRepo(false);
    await repo.create({
      id: "dep1",
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      status: "queued",
    });
    await repo.createBuildSession({
      deploymentId: "dep1",
      projectId: "p1",
      status: "queued",
    });
    const session = await repo.findBuildSessionByDeploymentId("dep1");
    await repo.claimBuildExecution({
      deploymentId: "dep1",
      buildSessionId: session!.id,
      projectId: "p1",
      organizationId: "org1",
    });
    await repo.updateStatus("dep1", "cancelled");

    expect((await repo.listInFlightByProject("p1")).map((row) => row.id)).toEqual(["dep1"]);
    await expect(repo.hasLiveBuildExecution("dep1", "p1")).resolves.toBe(true);
    await expect(repo.deleteDeployment("dep1")).resolves.toBe(false);
    await expect(repo.findById("dep1")).resolves.toBeDefined();
    await expect(
      repo.create({
        id: "dep2",
        projectId: "p1",
        organizationId: "org1",
        branch: "main",
        status: "queued",
      }),
    ).resolves.toBeUndefined();

    await repo.acknowledgeBuildExecutionFinished(session!.id);
    await expect(repo.hasLiveBuildExecution("dep1", "p1")).resolves.toBe(false);
    expect(await repo.listInFlightByProject("p1")).toEqual([]);
    await expect(
      repo.create({
        id: "dep2",
        projectId: "p1",
        organizationId: "org1",
        branch: "main",
        status: "queued",
      }),
    ).resolves.toMatchObject({ id: "dep2" });
  });
});
