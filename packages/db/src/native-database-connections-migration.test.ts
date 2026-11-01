import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("adds native references without changing existing connections and retains linked databases", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE cluster_database (id text PRIMARY KEY); CREATE TABLE project_connection (id text PRIMARY KEY, env_key text); INSERT INTO project_connection VALUES ('old', 'DATABASE_URL');",
    );
    const sql = await readFile(
      new URL("../drizzle/0189_native_database_connections.sql", import.meta.url),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    expect((await db.query("SELECT * FROM project_connection")).rows).toEqual([
      { id: "old", env_key: "DATABASE_URL", source_database_id: null },
    ]);
    await db.exec(
      "INSERT INTO cluster_database VALUES ('db'); UPDATE project_connection SET source_database_id = 'db' WHERE id = 'old';",
    );
    await expect(db.exec("DELETE FROM cluster_database WHERE id = 'db'")).rejects.toMatchObject({
      code: "23503",
    });
    await db.exec(
      "DELETE FROM project_connection WHERE id = 'old'; DELETE FROM cluster_database WHERE id = 'db';",
    );
  } finally {
    await db.close();
  }
});
