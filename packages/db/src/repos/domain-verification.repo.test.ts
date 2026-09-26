import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createDomainRepo } from "./domain.repo";

describe("persisted domain verification and retry eligibility", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: ReturnType<typeof createDomainRepo>;
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  beforeAll(async () => {
    client = new PGlite("memory://");
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
    });
    await client.exec("SET session_replication_role = replica");
    repo = createDomainRepo(db);
    await db.insert(schema.project).values([
      {
        id: "live",
        name: "Live",
        slug: "live",
        organizationId: "org",
        groupId: "g",
        activeDeploymentId: "deployment",
      },
      { id: "draft", name: "Draft", slug: "draft", organizationId: "org", groupId: "g-draft" },
      {
        id: "other",
        name: "Other",
        slug: "other",
        organizationId: "other-org",
        groupId: "g-other",
        activeDeploymentId: "deployment",
      },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });
  beforeEach(async () => {
    await db.delete(schema.domain);
  });

  const add = (id: string, patch: Partial<typeof schema.domain.$inferInsert> = {}) =>
    db.insert(schema.domain).values({
      id,
      hostname: `${id}.example.com`,
      projectId: "live",
      domainType: "custom",
      createdAt: minutesAgo(120),
      ...patch,
    });

  it("records the first failed check as failed with its reason and time", async () => {
    await add("failed");
    await repo.recordVerifyFailure("failed", "DNS points to a different server");
    expect(await repo.findById("failed")).toMatchObject({
      status: "failed",
      verified: false,
      verifyAttempts: 1,
      lastVerifyError: "DNS points to a different server",
      lastCheckedAt: expect.any(Date),
    });
  });

  it("counts concurrent failures atomically and does not overwrite a successful verification", async () => {
    await add("concurrent");
    await Promise.all(
      Array.from({ length: 6 }, () => repo.recordVerifyFailure("concurrent", "Connection refused")),
    );
    expect((await repo.findById("concurrent"))?.verifyAttempts).toBe(6);
    await repo.markVerifiedActive("concurrent", { sslStatus: "active" });
    await repo.recordVerifyFailure("concurrent", "A stale check failed");
    expect(await repo.findById("concurrent")).toMatchObject({
      status: "active",
      verified: true,
      sslStatus: "active",
      verifyAttempts: 0,
      lastVerifyError: null,
    });
  });

  it("selects due failures before applying the batch limit, including failures from before a restart", async () => {
    await add("backing-off", {
      status: "failed",
      verifyAttempts: 2,
      lastCheckedAt: minutesAgo(20),
    });
    await add("due", { status: "failed", verifyAttempts: 1, lastCheckedAt: minutesAgo(16) });
    await add("old-failure", {
      status: "failed",
      verifyAttempts: 20,
      lastCheckedAt: minutesAgo(361),
    });
    await add("fresh", { createdAt: minutesAgo(1) });
    await add("draft", { projectId: "draft" });
    await add("foreign", { projectId: "other" });
    const rows = await repo.findPendingVerification(minutesAgo(10), 2, "org");
    expect(rows.map((row) => row.id).sort()).toEqual(["due", "old-failure"]);
  });

  it("includes a first check at the exact end of its advertised grace period", async () => {
    const cutoff = minutesAgo(10);
    await add("first-check", { createdAt: cutoff });
    expect((await repo.findPendingVerification(cutoff, 50, "org")).map((row) => row.id)).toEqual([
      "first-check",
    ]);
  });

  it.each([false, true])(
    "rechecks only the selected domain with the same backoff and ownership rules (verified: %s)",
    async (verified) => {
      const state = { verified, status: verified ? "active" : "pending", sslStatus: "none" };
      await add("other-eligible", state);
      await add("selected", state);
      await add("foreign", { ...state, projectId: "other" });
      const recheck = (id: string) =>
        verified
          ? repo.findPendingSsl(1, "org", id)
          : repo.findPendingVerification(minutesAgo(10), 1, "org", id);

      expect((await recheck("selected")).map((row) => row.id)).toEqual(["selected"]);
      expect(await recheck("foreign")).toEqual([]);
      if (verified) await repo.recordSslFailure("selected", "Certificate check failed");
      else await repo.recordVerifyFailure("selected", "DNS check failed");
      expect(await recheck("selected")).toEqual([]);
      expect((await recheck("other-eligible")).map((row) => row.id)).toEqual(["other-eligible"]);
    },
  );

  it("retries failed certificate issuance without including manual, removing, or backed-off rows", async () => {
    const failure = {
      verified: true,
      status: "active",
      sslStatus: "error",
      verifyAttempts: 1,
      lastCheckedAt: minutesAgo(16),
    };
    await add("ssl-failed", failure);
    await add("ssl-manual", { ...failure, manualSsl: true });
    await add("ssl-busy", { ...failure, lastCheckedAt: minutesAgo(1) });
    await add("ssl-removing", { ...failure, status: "removing" });
    await add("ssl-draft", { ...failure, projectId: "draft" });
    expect((await repo.findPendingSsl(50, "org")).map((row) => row.id)).toEqual(["ssl-failed"]);
  });

  it.each([false, true])("never runs unattended DNS verification for manual TXT domains (verified: %s)", async (verified) => {
    const state = { verified, status: verified ? "active" : "pending", sslStatus: "none" };
    await add("provider-managed", state);
    await add("manual-txt", { ...state, sslDnsMode: "manual" });
    const rows = verified
      ? await repo.findPendingSsl(50, "org")
      : await repo.findPendingVerification(minutesAgo(10), 50, "org");
    expect(rows.map((row) => row.id)).toEqual(["provider-managed"]);
  });

  it("records a failed TLS check without downgrading a working certificate, then clears the failure atomically on success", async () => {
    await add("working", { verified: true, status: "active", sslStatus: "active" });
    await repo.recordSslFailure("working", "SSH unavailable");
    expect(await repo.findById("working")).toMatchObject({
      verified: true,
      status: "active",
      sslStatus: "active",
      verifyAttempts: 1,
      lastVerifyError: "SSH unavailable",
    });
    await repo.updateSsl("working", { sslStatus: "active" });
    expect(await repo.findById("working")).toMatchObject({
      verified: true,
      status: "active",
      sslStatus: "active",
      verifyAttempts: 0,
      lastVerifyError: null,
    });
    await repo.recordSslFailure("working", "No certificate on the server", true);
    expect(await repo.findById("working")).toMatchObject({
      verified: true,
      sslStatus: "error",
      verifyAttempts: 1,
      lastVerifyError: "No certificate on the server",
    });
  });

  it("does not erase a DNS verification failure when only a certificate probe succeeds", async () => {
    await add("dns-failure");
    await repo.recordVerifyFailure("dns-failure", "Ownership TXT record missing");
    const failed = await repo.findById("dns-failure");
    await repo.updateSsl("dns-failure", { sslStatus: "active" });
    expect(await repo.findById("dns-failure")).toMatchObject({
      verified: false,
      status: "failed",
      verifyAttempts: 1,
      lastCheckedAt: failed!.lastCheckedAt,
      lastVerifyError: "Ownership TXT record missing",
      sslStatus: "active",
    });
  });
});
