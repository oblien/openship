import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("preserves active and pending authenticators and retains lockout state on migration retries", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY, two_factor_enabled boolean NOT NULL);
      CREATE TABLE two_factor (id text PRIMARY KEY, user_id text NOT NULL, secret text NOT NULL, backup_codes text NOT NULL);
      INSERT INTO "user" VALUES ('active', true), ('pending', false);
      INSERT INTO two_factor VALUES ('a', 'active', 'encrypted-a', 'codes-a'), ('p', 'pending', 'encrypted-p', 'codes-p');
    `);
    const migration = await readFile(new URL("../drizzle/0218_two_factor_verification.sql", import.meta.url), "utf8");
    await db.exec(migration);
    expect((await db.query("SELECT id, verified, failed_verification_count, locked_until, secret FROM two_factor ORDER BY id")).rows).toEqual([
      { id: "a", verified: true, failed_verification_count: 0, locked_until: null, secret: "encrypted-a" },
      { id: "p", verified: false, failed_verification_count: 0, locked_until: null, secret: "encrypted-p" },
    ]);
    await db.exec("UPDATE two_factor SET failed_verification_count = 4, locked_until = '2030-01-01' WHERE id = 'a'");
    await db.exec(migration);
    expect((await db.query("SELECT verified, failed_verification_count, locked_until IS NOT NULL AS locked FROM two_factor WHERE id = 'a'")).rows).toEqual([
      { verified: true, failed_verification_count: 4, locked: true },
    ]);
  } finally {
    await db.close();
  }
});
