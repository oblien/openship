import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("enables checks on upgrade and preserves a saved opt-out when migration is retried", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE organization (id text PRIMARY KEY);
      INSERT INTO organization VALUES ('existing');`);
    const migration = await readFile(
      new URL("../drizzle/0219_security_advisory_checks.sql", import.meta.url),
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
