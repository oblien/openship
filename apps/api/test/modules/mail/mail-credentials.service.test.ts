import { PGlite } from "@electric-sql/pglite";
import type { CommandExecutor } from "@repo/adapters";
import { runMailSql } from "@repo/platform/engine/modules/mail/mail-engine";
import { expect, it, vi } from "vitest";
import { updatePostmasterPassword } from "../../../src/modules/mail/mail-credentials.service";

vi.mock("@repo/platform/engine/modules/mail/admin/password", () => ({
  hashPassword: async () => "{SSHA512}fixture-hash",
}));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", () => ({
  runMailSql: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-state", () => ({
  readState: async () => null,
  mutateState: vi.fn(),
}));

it("advances the postmaster password timestamp when rotating the hash", async () => {
  const db = new PGlite();
  try {
    // Execute the service's real SQL against the relevant iRedMail columns.
    await db.exec(`
      CREATE TABLE mailbox (
        username text PRIMARY KEY,
        password text NOT NULL,
        passwordlastchange timestamp NOT NULL DEFAULT NOW()
      );
      INSERT INTO mailbox VALUES
        ('postmaster@example.test', 'old-hash', TIMESTAMP '2000-01-01'),
        ('alice@example.test', 'untouched-hash', TIMESTAMP '2000-01-01');
    `);
    vi.mocked(runMailSql).mockImplementation(async (_target, statement) => {
      await db.query(statement);
      return "";
    });

    await updatePostmasterPassword({} as CommandExecutor, "example.test", "fixture-password");

    const { rows } = await db.query(`
      SELECT username, password, passwordlastchange > TIMESTAMP '2000-01-01' AS rotated
      FROM mailbox ORDER BY username
    `);
    expect(rows).toEqual([
      { username: "alice@example.test", password: "untouched-hash", rotated: false },
      { username: "postmaster@example.test", password: "{SSHA512}fixture-hash", rotated: true },
    ]);
  } finally {
    await db.close();
  }
});
