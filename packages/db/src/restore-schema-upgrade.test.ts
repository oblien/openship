import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("upgrades earlier workspace and advisory tables without replacing saved state", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE cloud_workspace (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE project_security (project_id text PRIMARY KEY, inventory jsonb, auto_refresh boolean NOT NULL);
      CREATE TABLE security_refresh_attempt (id text PRIMARY KEY, status text NOT NULL, deployment_id text);
      INSERT INTO cloud_workspace VALUES ('workspace', 'Existing workspace');
      INSERT INTO project_security VALUES ('project', '{"existing":true}', false);
      INSERT INTO security_refresh_attempt VALUES ('attempt', 'succeeded', 'deployment');
    `);
    const migration = await readFile(new URL("../drizzle/0230_restore_workspace_security_fields.sql", import.meta.url), "utf8");
    await db.exec(migration);
    expect((await db.query("SELECT * FROM cloud_workspace")).rows).toEqual([
      { id: "workspace", name: "Existing workspace", operation: null, pending_checkouts: [] },
    ]);
    expect((await db.query("SELECT * FROM project_security")).rows).toEqual([
      { project_id: "project", inventory: { existing: true }, auto_refresh: false, evaluated_at: null, feed_revision: 0 },
    ]);
    expect((await db.query("SELECT * FROM security_refresh_attempt")).rows).toEqual([
      { id: "attempt", status: "succeeded", deployment_id: "deployment", advisory_id: null, action_request_id: null, service_id: null, image: null },
    ]);

    await db.exec(`
      UPDATE cloud_workspace SET operation = '{"id":"operation"}', pending_checkouts = '[{"id":"checkout"}]';
      UPDATE project_security SET evaluated_at = '2026-11-11 20:00:00', feed_revision = 7;
      UPDATE security_refresh_attempt SET advisory_id = 'advisory', action_request_id = 'request', service_id = 'service', image = 'example:1';
    `);
    const before = await Promise.all([
      db.query("SELECT * FROM cloud_workspace"),
      db.query("SELECT * FROM project_security"),
      db.query("SELECT * FROM security_refresh_attempt"),
    ]);
    await db.exec(migration);
    expect(await Promise.all([
      db.query("SELECT * FROM cloud_workspace"),
      db.query("SELECT * FROM project_security"),
      db.query("SELECT * FROM security_refresh_attempt"),
    ])).toEqual(before);
  } finally {
    await db.close();
  }
});
