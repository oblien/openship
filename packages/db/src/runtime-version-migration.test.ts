import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("adds an optional runtime selection without changing old builds or deployment history", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE project (id text PRIMARY KEY, build_image text, active_deployment_id text); INSERT INTO project VALUES ('old', 'php:8.4-cli', 'release');",
    );
    const sql = await readFile(
      new URL("../drizzle/0188_project_runtime_version.sql", import.meta.url),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    expect((await db.query("SELECT * FROM project")).rows).toEqual([
      {
        id: "old",
        build_image: "php:8.4-cli",
        active_deployment_id: "release",
        runtime_version: null,
        runtime_image: null,
      },
    ]);
    await db.exec(
      "UPDATE project SET runtime_version = '8.3', runtime_image = 'custom/runtime:8.3' WHERE id = 'old'",
    );
    expect((await db.query("SELECT runtime_version, runtime_image FROM project")).rows).toEqual([
      { runtime_version: "8.3", runtime_image: "custom/runtime:8.3" },
    ]);
  } finally {
    await db.close();
  }
});
