import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { dockerMigrationRun } from "../schema";
import { createDockerMigrationRunRepo } from "./docker-migration.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) test for "is this project migrating?" — the question the project
 * payload answers for every status pill in the product.
 *
 * It has to be a real database. Half the predicate is a jsonb path extraction
 * (`input_snapshot #>> '{projectMove,projectId}'`), and the failure mode of a wrong path is
 * not an error: it is a silent empty result, i.e. a project that quietly reads "Live" in the
 * middle of being moved to another host. A mocked db would assert my own belief about the SQL.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // Runs reference organization/server/project rows we deliberately don't seed — the subject
  // here is the lookup predicate, not referential integrity.
  await client.exec("SET session_replication_role = replica;");
  return { db, repo: createDockerMigrationRunRepo(db) };
}

type Ctx = Awaited<ReturnType<typeof freshRepo>>;

/** One run row. `source` = a duplicate's SOURCE project, which lives in the start snapshot. */
async function addRun(
  ctx: Ctx,
  run: {
    id: string;
    status: string;
    mode?: string;
    projectId?: string | null;
    source?: string | null;
    startedAt?: Date;
    finishedAt?: Date | null;
    executionStartedAt?: Date | null;
    executionFinishedAt?: Date | null;
  },
) {
  await ctx.db.insert(dockerMigrationRun).values({
    id: run.id,
    organizationId: "org1",
    sourceServerId: "srvA",
    targetServerId: "srvB",
    projectName: run.projectId ?? "unnamed",
    status: run.status,
    mode: run.mode ?? "project_move",
    projectId: run.projectId ?? null,
    finishedAt: run.finishedAt ?? null,
    executionStartedAt: run.executionStartedAt ?? null,
    executionFinishedAt: run.executionFinishedAt ?? null,
    startedAt: run.startedAt ?? new Date("2026-01-01T00:00:00Z"),
    inputSnapshot: run.source
      ? { projectMove: { projectId: run.source, intent: "copy" }, organizationId: "org1" }
      : null,
  });
}

describe("findActiveForProject", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await freshRepo();
  }, 30_000);

  it("finds the run whose subject IS the project", async () => {
    await addRun(ctx, { id: "r1", status: "moving_data", projectId: "p1" });
    expect((await ctx.repo.findActiveForProject("p1"))?.id).toBe("r1");
  });

  it("finds a DUPLICATE's run from the source project in the snapshot", async () => {
    // A duplicate's `project_id` is repointed at the project it creates, so the source — the
    // project whose Advanced tab started the run, and whose volumes are being streamed — is
    // findable ONLY through the snapshot. This is the case a column-only predicate lost.
    await addRun(ctx, {
      id: "r2",
      status: "moving_data",
      mode: "project_copy",
      projectId: "copy-proj",
      source: "p1",
    });
    expect((await ctx.repo.findActiveForProject("p1"))?.id).toBe("r2");
    expect((await ctx.repo.findActiveForProject("copy-proj"))?.id).toBe("r2");
  });

  it("counts a run parked at awaiting_cutover — that is the one needing the operator", async () => {
    await addRun(ctx, { id: "r3", status: "awaiting_cutover", projectId: "p1" });
    expect((await ctx.repo.findActiveForProject("p1"))?.id).toBe("r3");
  });

  it("ignores terminal runs, and a finished row that kept an in-flight status", async () => {
    await addRun(ctx, { id: "done", status: "succeeded", projectId: "p1" });
    await addRun(ctx, { id: "failed", status: "failed", projectId: "p1" });
    await addRun(ctx, {
      id: "zombie",
      status: "moving_data",
      projectId: "p1",
      finishedAt: new Date("2026-01-01T01:00:00Z"),
    });
    expect(await ctx.repo.findActiveForProject("p1")).toBeNull();
  });

  it("keeps a terminal outcome active until its remote worker acknowledges exit", async () => {
    await addRun(ctx, {
      id: "settling",
      status: "succeeded",
      projectId: "p1",
      finishedAt: new Date("2026-01-01T01:00:00Z"),
      executionStartedAt: new Date("2026-01-01T00:30:00Z"),
    });

    expect((await ctx.repo.findActiveForProject("p1"))?.id).toBe("settling");
    await ctx.repo.acknowledgeExecutionFinished("settling");
    expect(await ctx.repo.findActiveForProject("p1")).toBeNull();
  });

  it("answers with the NEWEST in-flight run when a project somehow has two", async () => {
    await addRun(ctx, {
      id: "old",
      status: "moving_data",
      projectId: "p1",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await addRun(ctx, {
      id: "new",
      status: "adopting",
      projectId: "p1",
      startedAt: new Date("2026-02-01T00:00:00Z"),
    });
    expect((await ctx.repo.findActiveForProject("p1"))?.id).toBe("new");
  });

  it("says nothing for an unrelated project", async () => {
    await addRun(ctx, { id: "r1", status: "moving_data", projectId: "p1", source: "p0" });
    expect(await ctx.repo.findActiveForProject("p2")).toBeNull();
  });
});

describe("findActiveForProjects (the batched twin)", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await freshRepo();
  }, 30_000);

  it("agrees with the single-project lookup, project for project", async () => {
    await addRun(ctx, { id: "move", status: "deploying", projectId: "p1" });
    await addRun(ctx, {
      id: "copy",
      status: "moving_data",
      mode: "project_copy",
      projectId: "p2-copy",
      source: "p2",
    });
    await addRun(ctx, { id: "done", status: "succeeded", projectId: "p3" });

    const ids = ["p1", "p2", "p2-copy", "p3", "p4"];
    const batch = await ctx.repo.findActiveForProjects(ids);
    for (const id of ids) {
      const single = await ctx.repo.findActiveForProject(id);
      expect(batch.get(id)?.id ?? null, `project ${id}`).toBe(single?.id ?? null);
    }
  });

  it("returns one map entry per project ASKED FOR, so a duplicate's run answers twice", async () => {
    await addRun(ctx, {
      id: "copy",
      status: "moving_data",
      mode: "project_copy",
      projectId: "new-proj",
      source: "src-proj",
    });
    const batch = await ctx.repo.findActiveForProjects(["src-proj", "new-proj"]);
    expect([...batch.keys()].sort()).toEqual(["new-proj", "src-proj"]);
    expect(batch.get("src-proj")?.id).toBe("copy");
  });

  it("never returns an entry for a project that wasn't asked about", async () => {
    await addRun(ctx, {
      id: "copy",
      status: "moving_data",
      projectId: "new-proj",
      source: "src-proj",
    });
    const batch = await ctx.repo.findActiveForProjects(["src-proj"]);
    expect([...batch.keys()]).toEqual(["src-proj"]);
  });

  it("does no query, and answers empty, for no projects", async () => {
    await addRun(ctx, { id: "r1", status: "moving_data", projectId: "p1" });
    expect((await ctx.repo.findActiveForProjects([])).size).toBe(0);
  });

  it("prefers the newest run when one project has several in flight", async () => {
    await addRun(ctx, {
      id: "old",
      status: "moving_data",
      projectId: "p1",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await addRun(ctx, {
      id: "new",
      status: "verifying",
      projectId: "p1",
      startedAt: new Date("2026-03-01T00:00:00Z"),
    });
    expect((await ctx.repo.findActiveForProjects(["p1"])).get("p1")?.id).toBe("new");
  });
});

/**
 * A project's migration HISTORY — the same rows a server lists, asked from the other side.
 *
 * Terminal runs included (that is the whole point of a history) and the same "touches this
 * project" predicate as the active lookup, so a duplicate appears under both the source and the
 * copy: one row, two viewpoints, rather than a second table of per-project history.
 */
describe("listForProject", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await freshRepo();
  }, 30_000);

  it("lists terminal runs too, newest first", async () => {
    await addRun(ctx, {
      id: "old",
      status: "succeeded",
      projectId: "p1",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T01:00:00Z"),
    });
    await addRun(ctx, {
      id: "recent",
      status: "failed",
      projectId: "p1",
      startedAt: new Date("2026-05-01T00:00:00Z"),
      finishedAt: new Date("2026-05-01T01:00:00Z"),
    });
    const runs = await ctx.repo.listForProject("org1", "p1");
    expect(runs.map((r) => r.id)).toEqual(["recent", "old"]);
  });

  it("shows a duplicate under BOTH the source and the copy", async () => {
    await addRun(ctx, {
      id: "copy",
      status: "succeeded",
      mode: "project_copy",
      projectId: "new-proj",
      source: "src-proj",
    });
    expect((await ctx.repo.listForProject("org1", "src-proj")).map((r) => r.id)).toEqual(["copy"]);
    expect((await ctx.repo.listForProject("org1", "new-proj")).map((r) => r.id)).toEqual(["copy"]);
  });

  it("is organization-scoped", async () => {
    await addRun(ctx, { id: "mine", status: "succeeded", projectId: "p1" });
    expect(await ctx.repo.listForProject("org2", "p1")).toEqual([]);
  });

  it("says nothing for a project with no runs", async () => {
    await addRun(ctx, { id: "other", status: "succeeded", projectId: "p9" });
    expect(await ctx.repo.listForProject("org1", "p1")).toEqual([]);
  });
});
