import { describe, expect, test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { servers } from "./schema";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const GIB = 1024 ** 3;

async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { client, db };
}

describe("servers.build_cache_budget_bytes (migration 0224)", () => {
  test("stores a custom budget above the old 5 GiB ceiling and clears back to automatic", async () => {
    const { client, db } = await freshDb();
    const [row] = await db
      .insert(servers)
      .values({ organizationId: null, name: "build-box", sshHost: "203.0.113.9" })
      .returning();
    expect(row.buildCacheBudgetBytes).toBeNull();
    for (const v of [24 * GIB, null] as const) {
      await db.update(servers).set({ buildCacheBudgetBytes: v }).where(eq(servers.id, row.id));
      const [got] = await db.select().from(servers).where(eq(servers.id, row.id));
      expect(got.buildCacheBudgetBytes).toBe(v);
    }
    await client.close();
  });

  test("the database itself refuses budgets outside 1 GiB to 64 TiB", async () => {
    const { client } = await freshDb();
    await client.query(
      `INSERT INTO servers (id, name, ssh_host) VALUES ('s1', 'a', '203.0.113.9')`,
    );
    for (const value of [0, GIB - 1, 64 * 1024 ** 4 + 1]) {
      await expect(
        client.query(`UPDATE servers SET build_cache_budget_bytes = ${value} WHERE id = 's1'`),
      ).rejects.toThrow(/servers_build_cache_budget_check/);
    }
    await client.close();
  });
});
