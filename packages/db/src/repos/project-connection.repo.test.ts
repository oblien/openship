import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createProjectConnectionRepo } from "./project-connection.repo";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let repo: ReturnType<typeof createProjectConnectionRepo>;
beforeEach(async () => {
  client = new PGlite("memory://");
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  repo = createProjectConnectionRepo(db);
  await db.insert(schema.organization).values({ id: "org", name: "Workspace" });
  await db.insert(schema.projectGroup).values({ id: "group", organizationId: "org", name: "Projects", slug: "projects" });
  await db.insert(schema.project).values(["source", "consumer", "consumer2"].map(id => ({ id, name: id, slug: id, organizationId: "org", groupId: "group", environmentSlug: id })));
  await db.insert(schema.service).values({ id: "svc_db", projectId: "source", name: "db", image: "postgres:16" });
});
afterEach(async () => { await client.close(); });

const binding = (targetProjectId = "consumer", envKey = "DATABASE_URL", sourceServiceId = "svc_db") => ({
  connection: { organizationId: "org", sourceProjectId: "source", sourceServiceId, targetProjectId, outputId: "svc_db:url", envKey, mode: "internal" },
  encryptedValue: "encrypted-database-url",
});

describe("shared service bindings", () => {
  it("connects two projects to one service without creating another service", async () => {
    await repo.saveBindings("consumer", "production", [binding()]);
    await repo.saveBindings("consumer2", "production", [binding("consumer2")]);
    expect(await repo.listBySourceService("svc_db")).toHaveLength(2);
    expect(await db.query.service.findMany()).toHaveLength(1);
    expect((await db.query.envVar.findMany()).every(row => row.isSecret)).toBe(true);
  });

  it("rolls back the entire reconnect if another binding fails its FK", async () => {
    await repo.saveBindings("consumer", "production", [binding()]);
    const original = await repo.listByTarget("consumer");
    await expect(repo.saveBindings("consumer", "production", [
      { ...binding(), encryptedValue: "changed-secret" }, binding("consumer", "BROKEN", "missing-service"),
    ])).rejects.toThrow();
    expect(await repo.listByTarget("consumer")).toEqual(original);
    const vars = await db.query.envVar.findMany();
    expect(vars.map(row => [row.key, row.value])).toEqual([["DATABASE_URL", "encrypted-database-url"]]);
  });

  it("protects manually owned env vars while allowing service-scoped keys", async () => {
    await db.insert(schema.envVar).values({ id: "manual", projectId: "consumer", key: "DATABASE_URL", value: "manual", environment: "production" });
    await expect(repo.saveBindings("consumer", "production", [binding()])).rejects.toThrow(/already exists/);
    expect(await repo.listByTarget("consumer")).toEqual([]);
    await db.delete(schema.envVar).where(eq(schema.envVar.id, "manual"));
    await db.insert(schema.service).values({ id: "own_service", projectId: "consumer", name: "web" });
    await db.insert(schema.envVar).values({ id: "scoped", projectId: "consumer", serviceId: "own_service", key: "DATABASE_URL", value: "scoped", environment: "production" });
    await repo.saveBindings("consumer", "production", [binding()]);
    expect(await db.query.envVar.findMany()).toHaveLength(2);
  });

  it("protects the source from deletion and lets a consumer be deleted independently", async () => {
    await repo.saveBindings("consumer", "production", [binding()]);
    await expect(db.delete(schema.service).where(eq(schema.service.id, "svc_db"))).rejects.toThrow();
    await db.delete(schema.project).where(eq(schema.project.id, "consumer"));
    expect(await repo.listBySourceService("svc_db")).toEqual([]);
    expect(await db.query.service.findFirst()).toMatchObject({ id: "svc_db", projectId: "source" });
    await db.delete(schema.service).where(eq(schema.service.id, "svc_db"));
    expect(await db.query.service.findMany()).toEqual([]);
  });
});
