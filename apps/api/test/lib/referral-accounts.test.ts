import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { referralQueueAccounts } from "../../scripts/referral-accounts";
import { referralParticipantKey } from "@repo/platform/engine/modules/referrals/referral-provider";
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
  const alice = referralParticipantKey("alice"),
    unicode = referralParticipantKey("المستخدم"),
    deleted = referralParticipantKey("deleted");
  const result = await referralQueueAccounts(db, [alice, unicode, deleted, alice]);
  expect([...result.values()]).toHaveLength(2);
  expect(result.get(alice)).toEqual({ userId: "alice", email: "alice@example.test" });
  expect(result.get(unicode)).toEqual({ userId: "المستخدم", email: "unicode@example.test" });
  expect(result.has(deleted)).toBe(false);
  expect(result.has(referralParticipantKey("bob"))).toBe(false);
  expect(await referralQueueAccounts(db, [])).toEqual(new Map());
});
it("rejects forged and oversized lookup batches before querying", async () => {
  await expect(referralQueueAccounts(db, ["' OR true --"])).rejects.toThrow(
    "Invalid referral queue",
  );
  await expect(
    referralQueueAccounts(db, Array(101).fill(referralParticipantKey("alice"))),
  ).rejects.toThrow("Invalid referral queue");
});

it("does not transfer a deleted account's payout identity to a new account using the same email", async () => {
  await client.query('INSERT INTO "user" VALUES ($1,$2)', ["deleted-person", "reused@example.test"]);
  await client.query('DELETE FROM "user" WHERE id=$1', ["deleted-person"]);
  await client.query('INSERT INTO "user" VALUES ($1,$2)', ["new-person", "reused@example.test"]);
  const previous = referralParticipantKey("deleted-person"), current = referralParticipantKey("new-person");
  const result = await referralQueueAccounts(db, [previous, current]);
  expect(result.has(previous)).toBe(false);
  expect(result.get(current)).toEqual({ userId: "new-person", email: "reused@example.test" });
});
