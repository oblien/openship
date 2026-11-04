import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("retains old observations and consent, expires legacy evidence, and cascades host removal", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE organization (id text PRIMARY KEY);
      CREATE TABLE servers (id text PRIMARY KEY);
      CREATE TABLE project_security (project_id text PRIMARY KEY, inventory jsonb, auto_refresh boolean);
      CREATE TABLE job_run (server_id text, started_at timestamp);
      INSERT INTO organization VALUES ('org'); INSERT INTO servers VALUES ('host');
      INSERT INTO project_security VALUES ('app', '{"existing":true}', true);`);
    const sql = await readFile(
      new URL("../drizzle/0222_host_security_advisories.sql", import.meta.url),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    expect((await db.query("SELECT * FROM project_security")).rows).toEqual([
      {
        project_id: "app",
        inventory: { existing: true },
        auto_refresh: true,
        next_inspection_at: null,
        probe_failures: 0,
      },
    ]);
    await db.exec(
      `INSERT INTO server_security (server_id, organization_id) VALUES ('host', 'org'); DELETE FROM servers WHERE id='host';`,
    );
    expect((await db.query("SELECT * FROM server_security")).rows).toEqual([]);
  } finally {
    await db.close();
  }
});
