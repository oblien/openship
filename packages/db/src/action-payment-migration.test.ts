import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds payment recovery to existing Actions orders without changing receipts or balances", async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE "organization" ("id" text PRIMARY KEY);');
    await db.exec(
      await readFile(new URL("../drizzle/0173_action_billing.sql", import.meta.url), "utf8"),
    );
    await db.exec(`
      INSERT INTO organization (id) VALUES ('org-migration');
      INSERT INTO action_budget (organization_id, namespace, funded_units, spent_units, reserved_units)
        VALUES ('org-migration', 'actions-migration', 300000000, 4000, 8000);
      INSERT INTO action_credit_purchase (id, organization_id, idempotency_key, price_cents, request, checkout_id, status, funded_units)
        VALUES ('paid', 'org-migration', 'original-paid-key', 500, '{"original":true}', 'original-checkout', 'completed', 300000000),
               ('uncertain', 'org-migration', 'original-pending-key', 2000, '{"original":true}', NULL, 'pending', 0);
    `);
    const balances = (await db.query("SELECT * FROM action_budget")).rows;
    const orders = (await db.query("SELECT * FROM action_credit_purchase ORDER BY id")).rows;

    await db.exec(
      await readFile(
        new URL("../drizzle/0174_actions_payment_recovery.sql", import.meta.url),
        "utf8",
      ),
    );

    expect((await db.query("SELECT * FROM action_budget")).rows).toEqual(balances);
    const migrated = (
      await db.query<{ next_check_at: Date; check_attempts: number }>(
        "SELECT * FROM action_credit_purchase ORDER BY id",
      )
    ).rows;
    expect(
      migrated.map(({ next_check_at, check_attempts, ...order }) => {
        expect(next_check_at).toBeInstanceOf(Date);
        expect(check_attempts).toBe(0);
        return order;
      }),
    ).toEqual(orders);
  } finally {
    await db.close();
  }
});

it("removes the unused job-debit ledger while preserving prepaid deposits and queuing runner setup", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE organization (id text PRIMARY KEY); CREATE TABLE action_runner (id text PRIMARY KEY, cloud_pool_id text);",
    );
    await db.exec(
      await readFile(new URL("../drizzle/0173_action_billing.sql", import.meta.url), "utf8"),
    );
    await db.exec(
      await readFile(
        new URL("../drizzle/0174_actions_payment_recovery.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(`
      INSERT INTO organization (id) VALUES ('org');
      INSERT INTO action_budget (organization_id, namespace, funded_units) VALUES ('org', 'funded', 300000000);
      INSERT INTO action_credit_purchase (id, organization_id, idempotency_key, price_cents, request, checkout_id, status, funded_units)
        VALUES ('order', 'org', 'saved-key', 500, '{"original":true}', 'saved-checkout', 'completed', 300000000);
    `);
    const orders = (await db.query("SELECT * FROM action_credit_purchase")).rows;
    await db.exec(
      await readFile(new URL("../drizzle/0175_actions_prepaid_usage.sql", import.meta.url), "utf8"),
    );
    await db.exec(
      await readFile(
        new URL("../drizzle/0176_actions_runner_readiness.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (
        await db.query(
          "SELECT funded_units, runner_version, runner_setup_failed FROM action_budget",
        )
      ).rows,
    ).toEqual([{ funded_units: 300000000, runner_version: 0, runner_setup_failed: false }]);
    expect((await db.query("SELECT * FROM action_credit_purchase")).rows).toEqual(orders);
    expect((await db.query("SELECT to_regclass('action_charge') AS table")).rows).toEqual([
      { table: null },
    ]);
    await expect(
      db.exec("INSERT INTO action_runner VALUES ('bad', NULL, 'linux_2')"),
    ).rejects.toThrow();
    await db.exec("INSERT INTO action_runner VALUES ('one', 'funded', 'linux_2')");
    await expect(
      db.exec("INSERT INTO action_runner VALUES ('duplicate', 'funded', 'linux_2')"),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
