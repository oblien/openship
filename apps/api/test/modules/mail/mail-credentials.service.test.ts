import "./_setup-env";
import { Hono } from "hono";
import { readState } from "@repo/platform/engine/modules/mail/mail-state";
import { handleApiError } from "../../../src/middleware/error-handler";
import { mailRoutes } from "../../../src/modules/mail/mail.routes";
import { seedOwner, seedServer } from "../jobs/_harness";
import { PGlite } from "@electric-sql/pglite";
import type { CommandExecutor } from "@repo/adapters";
import { runMailSql } from "@repo/platform/engine/modules/mail/mail-engine";
import { expect, it, vi } from "vitest";
import { updatePostmasterPassword } from "../../../src/modules/mail/mail-credentials.service";

vi.mock("@repo/platform/engine/modules/mail/admin/password", () => ({
  hashPassword: () => "{SSHA512}fixture-hash",
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: async (_serverId: string, work: (exec: object) => unknown) => work({}) },
}));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", async (original) => ({
  ...(await original<object>()),
  runMailSql: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-state", async (original) => ({
  ...(await original<object>()),
  readState: vi.fn(),
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

    await expect(updatePostmasterPassword({} as CommandExecutor, "missing.test", "fixture-password"))
      .rejects.toThrow("Installation postmaster mailbox missing");

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

it("authorizes a postmaster rotation on the server named in the request body", async () => {
  const owner = await seedOwner({ instanceAdmin: true, bound: true });
  const server = await seedServer(owner.orgId);
  const foreign = await seedServer((await seedOwner()).orgId);
  vi.mocked(runMailSql).mockReset().mockResolvedValue("");
  vi.mocked(readState).mockResolvedValue({ domain: "example.test", serverId: server } as NonNullable<Awaited<ReturnType<typeof readState>>>);
  const app = new Hono().onError(handleApiError).route("/api/mail", mailRoutes);
  const rotate = (serverId: string) => app.request("/api/mail/credentials/postmaster", {
    method: "POST", headers: { ...owner.auth, "content-type": "application/json" },
    body: JSON.stringify({ serverId, password: "fixture-password" }),
  });

  expect([403, 404]).toContain((await rotate(foreign)).status);
  expect(runMailSql).not.toHaveBeenCalled();
  const result = await rotate(server);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ok: true });
  expect(runMailSql).toHaveBeenCalledOnce();
});
