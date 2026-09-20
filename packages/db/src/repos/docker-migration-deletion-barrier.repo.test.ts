import { beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDockerMigrationRunRepo } from "./docker-migration.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function freshContext(deletionInProgress: boolean) {
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
  return { db, repo: createDockerMigrationRunRepo(db) };
}

describe("Docker migration admission vs. project deletion", () => {
  let ctx: Awaited<ReturnType<typeof freshContext>>;

  beforeEach(async () => {
    ctx = await freshContext(false);
  }, 30_000);

  it("admits a project move while its source project is live", async () => {
    const run = await ctx.repo.create({
      id: "dmr-live",
      organizationId: "org1",
      projectId: "p1",
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "app",
      status: "queued",
      mode: "project_move",
      inputSnapshot: { projectMove: { projectId: "p1", intent: "move" } },
    });

    expect(run?.id).toBe("dmr-live");
  });

  it("refuses a project move after deletion has claimed its source", async () => {
    ctx = await freshContext(true);

    const run = await ctx.repo.create({
      id: "dmr-deleting",
      organizationId: "org1",
      projectId: "p1",
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "app",
      status: "queued",
      mode: "project_move",
      inputSnapshot: { projectMove: { projectId: "p1", intent: "move" } },
    });

    expect(run).toBeUndefined();
  });

  it("refuses to bind an adopt run to a project deletion already claimed", async () => {
    const run = await ctx.repo.create({
      id: "dmr-adopt",
      organizationId: "org1",
      projectId: null,
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "app",
      status: "adopting",
      mode: "cross_server",
    });
    expect(run).toBeDefined();

    await ctx.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(ctx.repo.bindProject("dmr-adopt", "p1", "org1")).resolves.toBe(false);
  });

  it("gives exactly one replica ownership of a partial-run resume", async () => {
    await ctx.repo.create({
      id: "dmr-resume",
      organizationId: "org1",
      projectId: "p1",
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "app",
      status: "partial",
      mode: "project_move",
      inputSnapshot: { projectMove: { projectId: "p1", intent: "move" } },
    });

    const claims = await Promise.all([
      ctx.repo.claimExecution({
        id: "dmr-resume",
        organizationId: "org1",
        from: "partial",
        to: "moving_data",
      }),
      ctx.repo.claimExecution({
        id: "dmr-resume",
        organizationId: "org1",
        from: "partial",
        to: "moving_data",
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      status: "moving_data",
      executionStartedAt: expect.any(Date),
      executionFinishedAt: null,
    });

    // A terminal verdict does not admit deletion while the callback can still
    // write; only the outer worker acknowledgement closes that window.
    await ctx.repo.transition("dmr-resume", "succeeded");
    expect((await ctx.repo.findActiveForProject("p1"))?.id).toBe("dmr-resume");
    await ctx.repo.acknowledgeExecutionFinished("dmr-resume");
    expect(await ctx.repo.findActiveForProject("p1")).toBeNull();
  });

  it("reclaims an acknowledged failed cutover without reopening the operator choice", async () => {
    await ctx.repo.create({
      id: "dmr-cutover-retry",
      organizationId: "org1",
      projectId: "p1",
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "app",
      status: "cutover",
      mode: "project_move",
      errorMessage: "previous cutover failed",
      inputSnapshot: { projectMove: { projectId: "p1", intent: "move" } },
    });

    const first = await ctx.repo.claimExecution({
      id: "dmr-cutover-retry",
      organizationId: "org1",
      from: "cutover",
      to: "cutover",
    });
    expect(first).toMatchObject({
      status: "cutover",
      errorMessage: null,
      executionStartedAt: expect.any(Date),
      executionFinishedAt: null,
    });

    await ctx.repo.acknowledgeExecutionFinished("dmr-cutover-retry");
    const second = await ctx.repo.claimExecution({
      id: "dmr-cutover-retry",
      organizationId: "org1",
      from: "cutover",
      to: "cutover",
    });
    expect(second).toMatchObject({
      status: "cutover",
      errorMessage: null,
      executionStartedAt: expect.any(Date),
      executionFinishedAt: null,
    });
  });

  it("refuses a parked-run claim after deletion wins admission", async () => {
    await ctx.repo.create({
      id: "dmr-parked",
      organizationId: "org1",
      projectId: "p1",
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "app",
      status: "partial",
      mode: "project_move",
      inputSnapshot: { projectMove: { projectId: "p1", intent: "move" } },
    });
    await ctx.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(
      ctx.repo.claimExecution({
        id: "dmr-parked",
        organizationId: "org1",
        from: "partial",
        to: "moving_data",
      }),
    ).resolves.toBeUndefined();
  });

  it("locks both a duplicate and its source before admitting resume", async () => {
    await ctx.db.insert(schema.project).values({
      id: "p2",
      organizationId: "org1",
      groupId: "g2",
      name: "copy",
      slug: "copy",
    });
    await ctx.repo.create({
      id: "dmr-copy",
      organizationId: "org1",
      projectId: "p2",
      sourceServerId: "srv-a",
      targetServerId: "srv-b",
      projectName: "copy",
      status: "partial",
      mode: "project_copy",
      inputSnapshot: { projectMove: { projectId: "p1", intent: "copy" } },
    });
    await ctx.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "p1"));

    await expect(
      ctx.repo.claimExecution({
        id: "dmr-copy",
        organizationId: "org1",
        from: "partial",
        to: "moving_data",
      }),
    ).resolves.toBeUndefined();
  });
});
