import { createEncryption } from "../encryption";
import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import * as schema from "../schema";
import { envVar } from "../schema";
import { createProjectRepo } from "./project.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) integration test for the env-var write repo methods —
 * the data-safety-critical path. FK enforcement is disabled for the session so
 * we can seed env_var rows without the project/organization chain; we are
 * testing the delete-SCOPE of merge/bulk, not referential integrity.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  return { db, repo: createProjectRepo(db, createEncryption("repository-test-secret")) };
}

async function seed(db: Awaited<ReturnType<typeof freshRepo>>["db"]) {
  await db.insert(envVar).values([
    { id: "e1", projectId: "p1", key: "KEEP", value: "old", environment: "production", isSecret: false },
    { id: "e2", projectId: "p1", key: "SECRET", value: "enc-secret", environment: "production", isSecret: true },
    { id: "e3", projectId: "p1", key: "DELETEME", value: "x", environment: "production", isSecret: false },
    // Different ENV — a production-scope op must never touch this.
    { id: "e4", projectId: "p1", key: "KEEP", value: "preview-val", environment: "preview", isSecret: false },
    // Service-scoped — a project-level (serviceId=null) op must never touch this.
    { id: "e5", projectId: "p1", key: "KEEP", value: "svc-val", environment: "production", serviceId: "svc1", isSecret: false },
    // Different PROJECT — never touched.
    { id: "e6", projectId: "p2", key: "OTHER", value: "v", environment: "production", isSecret: false },
  ]);
}

async function prodProjectLevel(db: Awaited<ReturnType<typeof freshRepo>>["db"]) {
  const rows = await db.query.envVar.findMany({
    where: and(eq(envVar.projectId, "p1"), eq(envVar.environment, "production")),
  });
  return rows.filter((r) => r.serviceId === null);
}

describe("project.repo env writes (PGlite)", () => {
  let ctx: Awaited<ReturnType<typeof freshRepo>>;
  beforeEach(async () => {
    ctx = await freshRepo();
    await seed(ctx.db);
  }, 30_000);

  it("mergeEnvVars touches ONLY the named keys — untouched secret + other scopes survive", async () => {
    await ctx.repo.mergeEnvVars(
      "p1",
      "production",
      [
        { key: "KEEP", value: "new", isSecret: false },
        { key: "NEW", value: "n", isSecret: false },
      ],
      ["DELETEME"],
    );

    const rows = await prodProjectLevel(ctx.db);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(Object.keys(byKey).sort()).toEqual(["KEEP", "NEW", "SECRET"]);
    expect(byKey.KEEP.value).toBe("new"); // upserted
    expect(byKey.NEW.value).toBe("n"); // inserted
    expect(byKey.DELETEME).toBeUndefined(); // deleted
    // The untouched secret is byte-for-byte intact — never re-sent, never wiped.
    expect(byKey.SECRET.value).toBe("enc-secret");
    expect(byKey.SECRET.isSecret).toBe(true);

    // Out-of-scope rows untouched.
    const preview = await ctx.db.query.envVar.findMany({
      where: and(eq(envVar.projectId, "p1"), eq(envVar.environment, "preview")),
    });
    expect(preview).toHaveLength(1);
    expect(preview[0].value).toBe("preview-val");

    const svc = await ctx.db.query.envVar.findMany({ where: eq(envVar.serviceId, "svc1") });
    expect(svc).toHaveLength(1);
    expect(svc[0].value).toBe("svc-val");

    const otherProject = await ctx.db.query.envVar.findMany({ where: eq(envVar.projectId, "p2") });
    expect(otherProject).toHaveLength(1);
  });

  it("mergeEnvVars with empty upserts + deletes is a no-op", async () => {
    await ctx.repo.mergeEnvVars("p1", "production", [], []);
    const rows = await prodProjectLevel(ctx.db);
    expect(rows.map((r) => r.key).sort()).toEqual(["DELETEME", "KEEP", "SECRET"]);
  });

  it("mergeEnvVars deletes a key with no replacement", async () => {
    await ctx.repo.mergeEnvVars("p1", "production", [], ["SECRET"]);
    const rows = await prodProjectLevel(ctx.db);
    expect(rows.find((r) => r.key === "SECRET")).toBeUndefined();
    expect(rows.map((r) => r.key).sort()).toEqual(["DELETEME", "KEEP"]);
  });

  it("bulkSetEnvVars REPLACES the project-level production scope only", async () => {
    await ctx.repo.bulkSetEnvVars("p1", "production", [{ key: "ONLY", value: "1", isSecret: false }]);

    const rows = await prodProjectLevel(ctx.db);
    expect(rows.map((r) => r.key)).toEqual(["ONLY"]); // whole scope replaced

    // Other env + service scope + other project still untouched.
    const preview = await ctx.db.query.envVar.findMany({
      where: and(eq(envVar.projectId, "p1"), eq(envVar.environment, "preview")),
    });
    expect(preview).toHaveLength(1);
    const svc = await ctx.db.query.envVar.findMany({ where: eq(envVar.serviceId, "svc1") });
    expect(svc).toHaveLength(1);
  });

  it("bulkSetEnvVars with [] clears the scope", async () => {
    await ctx.repo.bulkSetEnvVars("p1", "production", []);
    const rows = await prodProjectLevel(ctx.db);
    expect(rows).toHaveLength(0);
  });
});
