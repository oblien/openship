import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDomainDnsChallengeRepo } from "./domain-dns-challenge.repo";
import { createDomainRepo } from "./domain.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repository = createDomainDnsChallengeRepo(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
});
beforeEach(async () => {
  await db.delete(schema.domainDnsChallenge);
  await db.delete(schema.domain);
  await db.delete(schema.acmeAccount);
  await db
    .insert(schema.domain)
    .values({
      id: "dom_1",
      projectId: "project_1",
      hostname: "*.example.com",
      domainType: "custom",
    });
});
afterAll(() => client.close());

async function waiting() {
  const { row } = await repository.begin("dom_1", "manual");
  return (await repository.updateOwned(
    "dom_1",
    row.leaseId!,
    {
      status: "waiting",
      recordName: "_acme-challenge.example.com",
      recordValue: "actual-acme-value",
      orderEnc: "enc1:private-order",
    },
    true,
  ))!;
}

describe("durable DNS challenge claims", () => {
  it("admits one worker across simultaneous starts and stores the winning renewal mode", async () => {
    const attempts = await Promise.all([
      repository.begin("dom_1", "manual"),
      repository.begin("dom_1", "automatic"),
    ]);
    expect(attempts.filter((attempt) => attempt.claimed)).toHaveLength(1);
    expect(new Set(attempts.map(({ row }) => row.id)).size).toBe(1);
    const domain = await createDomainRepo(db).findById("dom_1");
    expect(domain?.sslDnsMode).toBe(attempts[0].row.mode);
    expect(domain?.sslChallenge).toBe("dns-01");
  });

  it("recovers the same TXT after reopening without a held lease or a new order", async () => {
    const row = await waiting();
    const reopened = createDomainDnsChallengeRepo(db);
    expect(await reopened.find("dom_1")).toMatchObject({
      id: row.id,
      recordValue: "actual-acme-value",
      leaseId: null,
    });
    const repeated = await reopened.begin("dom_1", "manual");
    expect(repeated.claimed).toBe(false);
    expect(repeated.row.id).toBe(row.id);
    const checks = await Promise.all([
      repository.claimCheck("dom_1", row.id),
      reopened.claimCheck("dom_1", row.id),
    ]);
    expect(checks.filter(Boolean)).toHaveLength(1);
  });

  it("fences a cancelled worker before it can install or resurrect private material", async () => {
    const row = await waiting();
    const checking = (await repository.claimCheck("dom_1", row.id))!;
    expect((await repository.cancel("dom_1", row.id))?.status).toBe("cancelling");
    expect(
      await repository.updateOwned("dom_1", checking.leaseId!, { status: "installing" }),
    ).toBeUndefined();
    expect(
      await repository.updateOwned(
        "dom_1",
        checking.leaseId!,
        { status: "waiting", orderEnc: "enc1:stale" },
        true,
      ),
    ).toBeUndefined();
    await repository.updateOwned("dom_1", checking.leaseId!, { status: "cancelled" }, true);
    expect(await repository.find("dom_1")).toMatchObject({
      status: "cancelled",
      orderEnc: null,
      leaseId: null,
    });
  });

  it("does not cancel an installation once it entered the runtime mutation", async () => {
    const row = await waiting();
    const checking = (await repository.claimCheck("dom_1", row.id))!;
    await repository.updateOwned("dom_1", checking.leaseId!, { status: "installing" });
    expect(await repository.cancel("dom_1", row.id)).toBeUndefined();
    await repository.updateOwned("dom_1", checking.leaseId!, { status: "completed" }, true);
    expect(await repository.find("dom_1")).toMatchObject({
      status: "completed",
      orderEnc: null,
      recordValue: row.recordValue,
    });
  });

  it("expires abandoned work and prevents the old worker overwriting its replacement", async () => {
    const { row } = await repository.begin("dom_1", "manual");
    await db
      .update(schema.domainDnsChallenge)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.domainDnsChallenge.domainId, "dom_1"));
    await repository.expire("dom_1");
    expect(await repository.find("dom_1")).toMatchObject({ status: "failed", orderEnc: null });
    const next = await repository.begin("dom_1", "automatic");
    expect(next.claimed).toBe(true);
    expect(next.row.id).not.toBe(row.id);
    expect(
      await repository.updateOwned("dom_1", row.leaseId!, { status: "completed" }, true),
    ).toBeUndefined();
    expect((await repository.find("dom_1"))?.id).toBe(next.row.id);
  });

  it.each(["checking", "installing"] as const)(
    "resumes an interrupted %s worker with the original order",
    async (status) => {
      const row = await waiting();
      const check = (await repository.claimCheck("dom_1", row.id))!;
      if (status === "installing")
        await repository.updateOwned("dom_1", check.leaseId!, { status });
      await db
        .update(schema.domainDnsChallenge)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000) });
      // A heartbeat or late result cannot revive a lease that already expired.
      expect(await repository.heartbeat("dom_1", check.leaseId!)).toBeUndefined();
      expect(
        await repository.updateOwned("dom_1", check.leaseId!, { status: "completed" }),
      ).toBeUndefined();
      await repository.expire("dom_1");
      expect(await repository.find("dom_1")).toMatchObject({
        id: row.id,
        status: "waiting",
        orderEnc: row.orderEnc,
        recordValue: row.recordValue,
        leaseId: null,
        error: expect.stringContaining("interrupted"),
      });
      expect((await repository.claimCheck("dom_1", row.id))?.leaseId).not.toBe(check.leaseId);
    },
  );

  it("settles cancellation after a worker disappears instead of reviving its order", async () => {
    const row = await waiting();
    await repository.claimCheck("dom_1", row.id);
    await repository.cancel("dom_1", row.id);
    await db.update(schema.domainDnsChallenge).set({ leaseExpiresAt: new Date(Date.now() - 1000) });
    await repository.expire("dom_1");
    expect(await repository.find("dom_1")).toMatchObject({
      status: "cancelled",
      orderEnc: null,
      error: null,
    });
  });

  it("expires a pending TXT record, removes its key and keeps cleanup instructions", async () => {
    const row = await waiting();
    await db
      .update(schema.domainDnsChallenge)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.domainDnsChallenge.domainId, "dom_1"));
    await repository.expire("dom_1");
    expect(await repository.find("dom_1")).toMatchObject({
      status: "expired",
      orderEnc: null,
      recordValue: row.recordValue,
    });
    expect(await repository.claimCheck("dom_1", row.id)).toBeUndefined();
    const next = await repository.begin("dom_1", "manual");
    expect(next.row).toMatchObject({ status: "preparing", recordName: null, recordValue: null });
  });

  it("reuses a CA signing identity only within the same organization and directory", async () => {
    const account = await repository.account(
      "org_1",
      "https://ca.example/directory",
      "enc1:key-one",
    );
    const repeated = await repository.account(
      "org_1",
      "https://ca.example/directory",
      "enc1:key-discarded",
    );
    const other = await repository.account("org_2", "https://ca.example/directory", "enc1:key-two");
    expect(repeated).toEqual(account);
    expect(other.id).not.toBe(account.id);
    expect(await repository.accountById("org_2", account.id)).toBeUndefined();
  });

  it("does not enqueue manual certificates for unattended renewal", async () => {
    await repository.begin("dom_1", "manual");
    await db
      .update(schema.domain)
      .set({ verified: true, sslStatus: "active", sslExpiresAt: new Date(Date.now() + 1000) })
      .where(eq(schema.domain.id, "dom_1"));
    const domains = createDomainRepo(db);
    expect(await domains.findExpiringSsl(new Date(Date.now() + 86_400_000))).toEqual([]);
    await db
      .update(schema.domain)
      .set({ sslDnsMode: "automatic" })
      .where(eq(schema.domain.id, "dom_1"));
    expect((await domains.findExpiringSsl(new Date(Date.now() + 86_400_000)))[0]?.id).toBe("dom_1");
  });
});
