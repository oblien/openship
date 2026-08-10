import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { domain } from "../schema";
import { createDomainRepo } from "./domain.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) integration test for the SSL-renewal selection query.
 * FK enforcement is disabled for the session so we can seed domain rows without
 * the project/organization chain; we are testing the sslStatus/expiry filter,
 * not referential integrity.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  return { db, repo: createDomainRepo(db) };
}

/** now + `days` (days may be negative for an already-expired cert). */
function inDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

describe("domain.repo findExpiringSsl (PGlite)", () => {
  let ctx: Awaited<ReturnType<typeof freshRepo>>;
  beforeEach(async () => {
    ctx = await freshRepo();
    await ctx.db.insert(domain).values([
      // active + expiring within the cutoff — the baseline renewal case.
      { id: "d1", projectId: "p1", hostname: "active-expiring.test", sslStatus: "active", sslExpiresAt: inDays(5) },
      // errored on a prior renew + still expiring — MUST be retried, else the
      // cert silently expires (findExpiringSsl is the only auto-renewal source).
      { id: "d2", projectId: "p1", hostname: "error-expiring.test", sslStatus: "error", sslExpiresAt: inDays(5) },
      // already expired + errored — the worst case; must still be picked up.
      { id: "d3", projectId: "p1", hostname: "error-expired.test", sslStatus: "error", sslExpiresAt: inDays(-2) },
      // active but far from expiry — outside the cutoff, must be skipped.
      { id: "d4", projectId: "p1", hostname: "active-fresh.test", sslStatus: "active", sslExpiresAt: inDays(60) },
      // externally-managed TLS — never our certbot to renew.
      { id: "d5", projectId: "p1", hostname: "external-expiring.test", sslStatus: "external", sslExpiresAt: inDays(5) },
      // mid-issuance — no cert to renew yet, must stay excluded.
      { id: "d6", projectId: "p1", hostname: "provisioning-expiring.test", sslStatus: "provisioning", sslExpiresAt: inDays(5) },
    ]);
  }, 30_000);

  it("selects active AND errored certs within the cutoff, excludes external/provisioning/fresh", async () => {
    const cutoff = inDays(14);
    const rows = await ctx.repo.findExpiringSsl(cutoff);
    const hostnames = rows.map((r) => r.hostname).sort();

    expect(hostnames).toEqual([
      "active-expiring.test",
      "error-expired.test",
      "error-expiring.test",
    ]);
  });
});
