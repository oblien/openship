import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { project, deployment } from "../schema";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) test for `countActiveOnServer` — the occupancy signal
 * that stops `server rm` from orphaning running containers. FK enforcement is
 * disabled so we can seed project/deployment rows without the org chain.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  return { db, repo: createDeploymentRepo(db) };
}

describe("deployment.repo countActiveOnServer (PGlite)", () => {
  let ctx: Awaited<ReturnType<typeof freshRepo>>;
  beforeEach(async () => {
    ctx = await freshRepo();
    await ctx.db.insert(deployment).values([
      { id: "dep1", projectId: "p1", organizationId: "o1", branch: "main", meta: { serverId: "srv1" } },
      { id: "dep2", projectId: "p2", organizationId: "o1", branch: "main", meta: { serverId: "srv2" } },
      // On srv1 too, but its project's active pointer is elsewhere — must NOT count.
      { id: "dep3", projectId: "p3", organizationId: "o1", branch: "main", meta: { serverId: "srv1" } },
    ]);
    await ctx.db.insert(project).values([
      { id: "p1", organizationId: "o1", groupId: "g1", name: "P1", slug: "p1", activeDeploymentId: "dep1" },
      { id: "p2", organizationId: "o1", groupId: "g2", name: "P2", slug: "p2", activeDeploymentId: "dep2" },
      // Active pointer null — a stale dep3 on srv1 doesn't make srv1 occupied.
      { id: "p3", organizationId: "o1", groupId: "g3", name: "P3", slug: "p3", activeDeploymentId: null },
    ]);
  }, 30_000);

  it("counts only projects whose ACTIVE deployment targets the server", async () => {
    expect(await ctx.repo.countActiveOnServer("srv1")).toBe(1); // p1 only (dep3 is not active)
    expect(await ctx.repo.countActiveOnServer("srv2")).toBe(1); // p2
    expect(await ctx.repo.countActiveOnServer("srv-unused")).toBe(0);
  });
});
