import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("upgrades the existing email queue without backfilling or changing pending and delivered mail", async () => {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const cutoff = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_customer_cancellation_email"),
  );
  expect(cutoff).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cutoff);
  const prefix = mkdtempSync(join(tmpdir(), "customer-cancellation-migration-"));
  const client = new PGlite("memory://");
  const db = drizzle(client);
  try {
    mkdirSync(join(prefix, "meta"));
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: prefix });
    await client.exec(`INSERT INTO organization (id, name) VALUES ('org', 'Owner');
      INSERT INTO "user" (id, name, email) VALUES ('user', 'Owner', 'owner@example.com');
      INSERT INTO cloud_customer_email (id, kind, user_id, organization_id, status, payment)
      VALUES ('receipt', 'invoice', 'user', 'org', 'pending', '{"paymentId":"in_paid"}'),
             ('welcome', 'signup', 'user', 'org', 'sent', NULL);`);
    await migrate(db, { migrationsFolder: migrations });
    await migrate(db, { migrationsFolder: migrations });
    expect(
      (
        await client.query(
          "SELECT id, status, payment, cancellation FROM cloud_customer_email ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { id: "receipt", status: "pending", payment: { paymentId: "in_paid" }, cancellation: null },
      { id: "welcome", status: "sent", payment: null, cancellation: null },
    ]);
    await client.exec(`INSERT INTO cloud_customer_email (id, kind, user_id, organization_id, cancellation)
      VALUES ('cancel', 'cancellation', 'user', 'org', '{"namespace":"ns","canceledAt":"2026-11-09T00:00:00Z"}');`);
    expect(
      (await client.query("SELECT cancellation FROM cloud_customer_email WHERE id='cancel'")).rows,
    ).toEqual([{ cancellation: { namespace: "ns", canceledAt: "2026-11-09T00:00:00Z" } }]);
    await expect(
      client.exec(`INSERT INTO cloud_customer_email (id, kind, user_id, organization_id)
      VALUES ('invalid', 'unknown', 'user', 'org')`),
    ).rejects.toThrow("cloud_customer_email_kind");
  } finally {
    await client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
}, 60000);
