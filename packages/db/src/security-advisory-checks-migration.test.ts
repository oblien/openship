import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("enables checks on upgrade and preserves a saved opt-out when migration is retried", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE organization (id text PRIMARY KEY);
      INSERT INTO organization VALUES ('existing');`);
    const migration = await readFile(
      new URL("../drizzle/0221_security_advisory_checks.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    expect(
      (await db.query("SELECT security_advisory_checks_enabled FROM organization")).rows,
    ).toEqual([{ security_advisory_checks_enabled: true }]);
    await db.exec("UPDATE organization SET security_advisory_checks_enabled = false");
    await db.exec(migration);
    expect(
      (await db.query("SELECT security_advisory_checks_enabled FROM organization")).rows,
    ).toEqual([{ security_advisory_checks_enabled: false }]);
  } finally {
    await db.close();
  }
});

it("upgrades an OAuth-provider database with both advisory migrations and retains saved settings", async () => {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const cutoff = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_security_advisory_checks"),
  );
  expect(cutoff).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cutoff);
  const prefix = await mkdtemp(join(tmpdir(), "advisory-upgrade-"));
  const db = new PGlite();
  const orm = drizzle(db);
  try {
    await mkdir(join(prefix, "meta"));
    await writeFile(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      await copyFile(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await migrate(orm, { migrationsFolder: prefix });
    await db.exec(`
      INSERT INTO organization (id, name) VALUES ('existing', 'Existing workspace');
      INSERT INTO oauth_client (id, client_id, disabled, redirect_uris)
        VALUES ('client', 'existing-client', true, ARRAY['https://client.example/callback']);
    `);
    await migrate(orm, { migrationsFolder: migrations });
    expect(
      (await db.query("SELECT security_advisory_checks_enabled FROM organization")).rows,
    ).toEqual([{ security_advisory_checks_enabled: true }]);
    await db.exec("UPDATE organization SET security_advisory_checks_enabled = false");
    await migrate(orm, { migrationsFolder: migrations });
    expect(
      (await db.query("SELECT security_advisory_checks_enabled FROM organization")).rows,
    ).toEqual([{ security_advisory_checks_enabled: false }]);
    expect((await db.query("SELECT * FROM server_security")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM security_scan_state")).rows).toEqual([]);
    expect(
      (await db.query("SELECT client_id, disabled, redirect_uris FROM oauth_client")).rows,
    ).toEqual([
      {
        client_id: "existing-client",
        disabled: true,
        redirect_uris: ["https://client.example/callback"],
      },
    ]);
  } finally {
    await db.close();
    await rm(prefix, { recursive: true, force: true });
  }
}, 60_000);
