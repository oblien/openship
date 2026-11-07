import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabase } from "./connection";

const retiredTables = [
  "cloud_analytics_event",
  "cloud_analytics_checkout",
  "cloud_analytics_workspace",
];

it("retires populated product telemetry idempotently while retaining organizations and billing records", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE organization (id text PRIMARY KEY);
      CREATE TABLE billing_usage_snapshot (id text PRIMARY KEY, organization_id text REFERENCES organization(id), amount integer);
      INSERT INTO organization VALUES ('org');
      INSERT INTO billing_usage_snapshot VALUES ('billing', 'org', 100);
    `);
    await db.exec(
      await readFile(new URL("../drizzle/0151_cloud_analytics.sql", import.meta.url), "utf8"),
    );
    await db.exec(`
      INSERT INTO cloud_analytics_event (id, organization_id, event, distinct_id, properties) VALUES ('event', 'org', 'legacy', 'user', '{}');
      INSERT INTO cloud_analytics_checkout (id, organization_id, user_id, kind) VALUES ('checkout', 'org', 'user', 'subscription');
      INSERT INTO cloud_analytics_workspace (organization_id, state) VALUES ('org', '{}');
    `);
    const migration = await readFile(
      new URL("../drizzle/0225_retire_cloud_product_analytics.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    for (const table of retiredTables)
      expect((await db.query("SELECT to_regclass($1) AS relation", [table])).rows).toEqual([
        { relation: null },
      ]);
    expect((await db.query("SELECT * FROM organization")).rows).toEqual([{ id: "org" }]);
    expect((await db.query("SELECT * FROM billing_usage_snapshot")).rows).toEqual([
      { id: "billing", organization_id: "org", amount: 100 },
    ]);
  } finally {
    await db.close();
  }
});

it("applies the retirement through the complete fresh-install migration journal", async () => {
  const connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  try {
    for (const table of retiredTables) {
      const result = await connection.db.execute(sql`SELECT to_regclass(${table}) AS relation`);
      expect(result.rows).toEqual([{ relation: null }]);
    }
  } finally {
    await connection.close();
  }
}, 30_000);
