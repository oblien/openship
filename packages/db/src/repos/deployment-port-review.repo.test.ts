import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo } from "./deployment.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDeploymentRepo(db, createEncryption("repository-test-secret"));

beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
  });
  await client.exec("SET session_replication_role = replica;");
});
afterAll(() => client.close());

describe("port review dismissal", () => {
  it("keeps concurrent dismissals and metadata updates without rewriting the deployment status", async () => {
    const portCheck = [{ port: 3000, checked: true, listening: true, loopbackOnly: true }];
    await db.insert(schema.deployment).values({
      id: "live",
      projectId: "project",
      organizationId: "org",
      status: "ready",
      branch: "main",
      meta: { portCheck },
    });
    await Promise.all([
      repo.skipPortCheck("live", 3000),
      repo.skipPortCheck("live", "svc-api"),
      repo.skipPortCheck("live", 3000),
      // A separate lifecycle writer can change status while the user reviews.
      db
        .update(schema.deployment)
        .set({
          status: "stopped",
          meta: sql`${schema.deployment.meta} || '{"edgeUnsynced":true}'::jsonb`,
        })
        .where(eq(schema.deployment.id, "live")),
    ]);
    const row = await repo.findById("live");
    expect(row?.status).toBe("stopped");
    expect(row?.meta).toMatchObject({ portCheck, edgeUnsynced: true });
    expect((row?.meta as { portCheckSkipped: unknown[] }).portCheckSkipped).toHaveLength(2);
    expect((row?.meta as { portCheckSkipped: unknown[] }).portCheckSkipped).toEqual(
      expect.arrayContaining([3000, "svc-api"]),
    );
  });

  it("initializes missing metadata and retains numeric versus string dismissal targets", async () => {
    await db
      .insert(schema.deployment)
      .values({
        id: "legacy",
        projectId: "other",
        organizationId: "org",
        status: "ready",
        branch: "main",
      });
    await repo.skipPortCheck("legacy", 3000);
    await repo.skipPortCheck("legacy", "3000");
    await repo.skipPortCheck("legacy", 3000);
    expect((await repo.findById("legacy"))?.meta).toEqual({ portCheckSkipped: [3000, "3000"] });
  });
});
