import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("upgrades support without claiming anonymous tickets or losing queued mail", async () => {
  const client = new PGlite("memory://");
  try {
    await client.exec(
      readFileSync(new URL("../drizzle/0152_cloud_support.sql", import.meta.url), "utf8"),
    );
    await client.exec(`
      INSERT INTO cloud_support_ticket (id, input_hash, name, email, subject, message, source, status)
      VALUES ('legacy', 'hash', 'Customer', 'customer@example.test', 'Help', 'Existing request', 'support', 'resolved');
      INSERT INTO cloud_support_message (id, ticket_id, kind, body, attempts, last_error)
      VALUES ('reply', 'legacy', 'reply', 'Saved operator reply', 2, 'Delivery unavailable');
    `);
    const before = await client.query("SELECT * FROM cloud_support_message");
    await client.exec(
      readFileSync(new URL("../drizzle/0167_cloud_support_customers.sql", import.meta.url), "utf8"),
    );
    expect(
      (
        await client.query(
          "SELECT owner_user_id, category, status, message FROM cloud_support_ticket",
        )
      ).rows,
    ).toEqual([
      { owner_user_id: null, category: "general", status: "resolved", message: "Existing request" },
    ]);
    expect((await client.query("SELECT * FROM cloud_support_message")).rows).toEqual(before.rows);
    await client.exec(
      "INSERT INTO cloud_support_message (id, ticket_id, kind, body) VALUES ('customer-reply', 'legacy', 'customer_reply', 'More details')",
    );
    await expect(
      client.exec("UPDATE cloud_support_message SET kind = 'invalid' WHERE id = 'reply'"),
    ).rejects.toThrow("cloud_support_message_kind_check");
  } finally {
    await client.close();
  }
});
