import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds a Pages default without rewriting existing deployment history", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE project (id text PRIMARY KEY, active_deployment_id text);
      INSERT INTO project VALUES ('existing', 'docker-release');`);
    await db.exec(
      await readFile(new URL("../drizzle/0168_cloud_static_hosting.sql", import.meta.url), "utf8"),
    );
    expect((await db.query("SELECT * FROM project")).rows).toEqual([
      { id: "existing", active_deployment_id: "docker-release", cloud_static_hosting: "pages" },
    ]);
    await db.exec(
      "INSERT INTO project (id) VALUES ('new'); UPDATE project SET cloud_static_hosting = 'server' WHERE id = 'existing';",
    );
    expect(
      (await db.query("SELECT id, cloud_static_hosting FROM project ORDER BY id")).rows,
    ).toEqual([
      { id: "existing", cloud_static_hosting: "server" },
      { id: "new", cloud_static_hosting: "pages" },
    ]);
  } finally {
    await db.close();
  }
});
