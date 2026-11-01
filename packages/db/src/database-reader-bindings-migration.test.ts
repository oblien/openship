import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("adds reader bindings without modifying existing databases or writer secrets", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE cluster_database (id text PRIMARY KEY, config jsonb, secret_encrypted text, env_key text, env_value_encrypted text); INSERT INTO cluster_database VALUES ('existing', '{\"engine\":\"postgres\",\"mode\":\"standalone\",\"instances\":1}', 'database-secret', 'DATABASE_URL', 'writer-secret');",
    );
    const sql = await readFile(
      new URL("../drizzle/0203_database_reader_bindings.sql", import.meta.url),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    expect((await db.query("SELECT * FROM cluster_database")).rows).toEqual([
      {
        id: "existing",
        config: { engine: "postgres", mode: "standalone", instances: 1 },
        secret_encrypted: "database-secret",
        env_key: "DATABASE_URL",
        env_value_encrypted: "writer-secret",
        read_env_key: null,
        read_env_value_encrypted: null,
      },
    ]);
  } finally {
    await db.close();
  }
});
