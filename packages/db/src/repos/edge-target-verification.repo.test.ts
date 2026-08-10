import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createEdgeTargetVerificationRepo } from "./edge-target-verification.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) tests, because the interesting behaviour is the upsert
 * conflict on (organization_id, target) and the token-retention rule — neither of
 * which a mock would exercise.
 *
 * The rule that matters: Openship Cloud's edge re-probes THE SAME token within 7 days
 * of its 90-day expiry, so a token we stop serving silently kills that route ~83 days
 * after a green deploy. A re-issued challenge must therefore RETIRE the previous token
 * (keep serving it) rather than replace it, and nothing here is ever deleted when a
 * free domain is dropped.
 */
async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip org/server FK seeding
  return createEdgeTargetVerificationRepo(db);
}

const base = {
  organizationId: "org-1",
  target: "http://203.0.113.10",
  host: "203.0.113.10",
};

describe("edgeTargetVerification repo", () => {
  it("records a challenge and reads it back by target", async () => {
    const repo = await freshDb();
    await repo.recordChallenge({ ...base, verificationId: 42, token: "tok-aaaaaaaaaaaa", challengePath: "/p/tok-aaaaaaaaaaaa" });

    const row = await repo.findByTarget("org-1", "http://203.0.113.10");
    expect(row).toMatchObject({
      verificationId: 42,
      token: "tok-aaaaaaaaaaaa",
      challengePath: "/p/tok-aaaaaaaaaaaa",
      status: "pending",
    });
  });

  it("is keyed on (org, target) — a second org targeting the same box gets its own row", async () => {
    // Two orgs on one box means two tokens, one directory, one vhost.
    const repo = await freshDb();
    await repo.recordChallenge({ ...base, token: "tok-aaaaaaaaaaaa" });
    await repo.recordChallenge({ ...base, organizationId: "org-2", token: "tok-bbbbbbbbbbbb" });

    expect((await repo.findByTarget("org-1", base.target))?.token).toBe("tok-aaaaaaaaaaaa");
    expect((await repo.findByTarget("org-2", base.target))?.token).toBe("tok-bbbbbbbbbbbb");
  });

  it("RETIRES the previous token on re-issue instead of dropping it", async () => {
    // The upstream may still probe the old token until its record expires.
    const repo = await freshDb();
    await repo.recordChallenge({ ...base, token: "tok-oldoldoldold" });
    await repo.recordChallenge({ ...base, token: "tok-newnewnewnew" });

    const row = await repo.findByTarget("org-1", base.target);
    expect(row?.token).toBe("tok-newnewnewnew");
    expect(row?.retiredTokens).toEqual(["tok-oldoldoldold"]);
    // Both must still be served.
    expect(repo.servableTokens(row)).toEqual(["tok-newnewnewnew", "tok-oldoldoldold"]);
  });

  it("never lets a token appear twice, and never retires the current one", async () => {
    const repo = await freshDb();
    await repo.recordChallenge({ ...base, token: "tok-aaaaaaaaaaaa" });
    await repo.recordChallenge({ ...base, token: "tok-bbbbbbbbbbbb" });
    // Re-issuing the SAME token (an idempotent retry) must not retire it.
    await repo.recordChallenge({ ...base, token: "tok-bbbbbbbbbbbb" });

    const row = await repo.findByTarget("org-1", base.target);
    expect(row?.token).toBe("tok-bbbbbbbbbbbb");
    expect(row?.retiredTokens).toEqual(["tok-aaaaaaaaaaaa"]);
    expect(repo.servableTokens(row)).toEqual(["tok-bbbbbbbbbbbb", "tok-aaaaaaaaaaaa"]);
  });

  it("caps retired tokens so the list can't grow without bound", async () => {
    const repo = await freshDb();
    for (let i = 0; i < 15; i++) {
      await repo.recordChallenge({ ...base, token: `tok-${String(i).padStart(12, "0")}` });
    }

    const row = await repo.findByTarget("org-1", base.target);
    expect(row?.retiredTokens?.length).toBe(10);
    // Most-recently-retired first, so the cap drops the oldest.
    expect(row?.retiredTokens?.[0]).toBe("tok-000000000013");
  });

  it("records a check outcome and clears the prior error", async () => {
    const repo = await freshDb();
    const row = await repo.recordChallenge({ ...base, token: "tok-aaaaaaaaaaaa" });
    await repo.recordCheck(row.id, { status: "failed", lastError: "probe timed out" });
    expect((await repo.findByTarget("org-1", base.target))?.lastError).toBe("probe timed out");

    const expires = new Date("2026-11-01T00:00:00Z");
    await repo.recordCheck(row.id, { status: "verified", validatedIp: "203.0.113.10", expiresAt: expires });

    const after = await repo.findByTarget("org-1", base.target);
    expect(after).toMatchObject({ status: "verified", validatedIp: "203.0.113.10", lastError: null });
    expect(after?.expiresAt?.toISOString()).toBe(expires.toISOString());
    expect(after?.lastCheckedAt).toBeTruthy();
  });

  it("a re-issue keeps the row and clears the stale error", async () => {
    const repo = await freshDb();
    const row = await repo.recordChallenge({ ...base, token: "tok-aaaaaaaaaaaa" });
    await repo.recordCheck(row.id, { status: "failed", lastError: "too_many_attempts" });

    await repo.recordChallenge({ ...base, token: "tok-bbbbbbbbbbbb" });

    const after = await repo.findByTarget("org-1", base.target);
    expect(after).toMatchObject({ status: "pending", lastError: null });
  });

  it("recordServeError leaves status and lastCheckedAt alone", async () => {
    // The upstream owns `status`. A box that has temporarily lost its token file is
    // still verified there, and flipping it here would report a live route as dead —
    // and reset the timestamp that gates re-attempts.
    const repo = await freshDb();
    const row = await repo.recordChallenge({ ...base, token: "tok-aaaaaaaaaaaa" });
    await repo.recordCheck(row.id, { status: "verified", validatedIp: "203.0.113.10" });
    const verified = await repo.findByTarget("org-1", base.target);

    await repo.recordServeError(row.id, "not answering on :80");
    const after = await repo.findByTarget("org-1", base.target);
    expect(after).toMatchObject({ status: "verified", lastError: "not answering on :80" });
    expect(after?.lastCheckedAt?.toISOString()).toBe(verified?.lastCheckedAt?.toISOString());

    await repo.recordServeError(row.id, null);
    expect((await repo.findByTarget("org-1", base.target))?.lastError).toBeNull();
  });

  it("listAll spans organizations, because the sweep is scoped to the box not the org", async () => {
    const repo = await freshDb();
    await repo.recordChallenge({ ...base, token: "tok-aaaaaaaaaaaa" });
    await repo.recordChallenge({ ...base, organizationId: "org-2", token: "tok-bbbbbbbbbbbb" });
    await repo.recordChallenge({
      ...base,
      target: "http://198.51.100.7",
      host: "198.51.100.7",
      token: "tok-cccccccccccc",
    });

    const all = await repo.listAll();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((r) => r.organizationId))).toEqual(new Set(["org-1", "org-2"]));
  });

  it("servableTokens is empty for no row, so a caller can't accidentally serve nothing-as-something", async () => {
    const repo = await freshDb();
    expect(repo.servableTokens(undefined)).toEqual([]);
  });
});
