import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { affiliateQueueAccounts } from "../../scripts/affiliate-accounts";
import { affiliateParticipantKey } from "@repo/platform/engine/modules/affiliates/affiliate-provider";
import { schema } from "@repo/db/factory";

const client = new PGlite();
const db = drizzle(client, { schema });
beforeAll(async () => {
  await client.exec('CREATE TABLE "user" (id text PRIMARY KEY, email text NOT NULL)');
  await client.query('INSERT INTO "user" VALUES ($1,$2),($3,$4),($5,$6)', [
    "alice",
    "alice@example.test",
    "bob",
    "bob@example.test",
    "المستخدم",
    "unicode@example.test",
  ]);
});
afterAll(() => client.close());

it("resolves only the queued participants with the same hash as checkout and preserves missing accounts", async () => {
  const alice = affiliateParticipantKey("alice"),
    unicode = affiliateParticipantKey("المستخدم"),
    deleted = affiliateParticipantKey("deleted");
  const result = await affiliateQueueAccounts(db, [alice, unicode, deleted, alice]);
  expect([...result.values()]).toHaveLength(2);
  expect(result.get(alice)).toEqual({ userId: "alice", email: "alice@example.test" });
  expect(result.get(unicode)).toEqual({ userId: "المستخدم", email: "unicode@example.test" });
  expect(result.has(deleted)).toBe(false);
  expect(result.has(affiliateParticipantKey("bob"))).toBe(false);
  expect(await affiliateQueueAccounts(db, [])).toEqual(new Map());
});
it("rejects forged and oversized lookup batches before querying", async () => {
  await expect(affiliateQueueAccounts(db, ["' OR true --"])).rejects.toThrow(
    "Invalid affiliate queue",
  );
  await expect(
    affiliateQueueAccounts(db, Array(101).fill(affiliateParticipantKey("alice"))),
  ).rejects.toThrow("Invalid affiliate queue");
});

it("does not transfer a deleted account's payout identity to a new account using the same email", async () => {
  await client.query('INSERT INTO "user" VALUES ($1,$2)', ["deleted-person", "reused@example.test"]);
  await client.query('DELETE FROM "user" WHERE id=$1', ["deleted-person"]);
  await client.query('INSERT INTO "user" VALUES ($1,$2)', ["new-person", "reused@example.test"]);
  const previous = affiliateParticipantKey("deleted-person"), current = affiliateParticipantKey("new-person");
  const result = await affiliateQueueAccounts(db, [previous, current]);
  expect(result.has(previous)).toBe(false);
  expect(result.get(current)).toEqual({ userId: "new-person", email: "reused@example.test" });
});
