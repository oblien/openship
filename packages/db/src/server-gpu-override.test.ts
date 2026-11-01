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

async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { client, db };
}

const base = {
  organizationId: null,
  name: "gpu-box",
  sshHost: "203.0.113.9",
} as const;

describe("servers.gpu_override (migration 0190)", () => {
  test("accepts yes and no, and can be cleared back to NULL", async () => {
    const { client, db } = await freshDb();
    const [row] = await db
      .insert(servers)
      .values({ ...base })
      .returning();
    for (const v of ["yes", "no", null] as const) {
      await db.update(servers).set({ gpuOverride: v }).where(eq(servers.id, row.id));
      const [got] = await db.select().from(servers).where(eq(servers.id, row.id));
      expect(got.gpuOverride).toBe(v);
    }
    await client.close();
  });

  test("the database itself refuses any other value (not just the TS enum)", async () => {
    const { client } = await freshDb();
    await client.query(
      `INSERT INTO servers (id, name, ssh_host) VALUES ('s1', 'a', '203.0.113.9')`,
    );
    await expect(
      client.query(`UPDATE servers SET gpu_override = 'maybe' WHERE id = 's1'`),
    ).rejects.toThrow(/servers_gpu_override_check/);
    await client.close();
  });
});
