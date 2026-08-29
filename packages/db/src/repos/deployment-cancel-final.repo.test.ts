import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { deployment } from "../schema";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) test for the one guard that makes a cancel stick.
 *
 * Cancellation is cooperative and the deploy phase doesn't check for it, so the
 * work a cancel interrupts keeps running and reaches its own success hook. This
 * predicate is what stops that hook from writing `ready` over the cancellation —
 * and it has to be enforced in SQL, because the racing writer is a different
 * async task with a stale read of the row.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  const repo = createDeploymentRepo(db);
  await db.insert(deployment).values({
    id: "d1",
    projectId: "p1",
    organizationId: "org1",
    status: "building",
    branch: "main",
  });
  return { db, repo };
}

const statusOf = async (db: Awaited<ReturnType<typeof freshRepo>>["db"]) =>
  (await db.query.deployment.findFirst({ where: eq(deployment.id, "d1") }))?.status;

describe("updateStatus — a cancelled row is final", () => {
  it("refuses to move a cancelled deployment to ready", async () => {
    const { db, repo } = await freshRepo();

    expect(await repo.updateStatus("d1", "cancelled")).toBe(true);
    expect(await repo.updateStatus("d1", "ready")).toBe(false);
    expect(await statusOf(db)).toBe("cancelled");
  });

  it("drops the extras of a refused write instead of applying them partially", async () => {
    const { db, repo } = await freshRepo();
    await repo.updateStatus("d1", "cancelled");

    // A success hook carries the release payload alongside the status. Landing
    // the payload while refusing the status would publish a cancelled build as a
    // numbered release.
    expect(await repo.updateStatus("d1", "ready", { releaseVersion: "7" })).toBe(false);

    const row = await db.query.deployment.findFirst({ where: eq(deployment.id, "d1") });
    expect(row?.status).toBe("cancelled");
    expect(row?.releaseVersion).toBeNull();
  });

  it("still allows every other transition", async () => {
    const { db, repo } = await freshRepo();

    expect(await repo.updateStatus("d1", "deploying")).toBe(true);
    expect(await repo.updateStatus("d1", "ready")).toBe(true);
    expect(await statusOf(db)).toBe("ready");
  });

  it("reports false for a row that does not exist", async () => {
    const { repo } = await freshRepo();

    expect(await repo.updateStatus("nope", "ready")).toBe(false);
  });
});
