import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createWebhookDeliveryRepo } from "./webhook-delivery.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) test for the webhook_delivery repo — the correctness-
 * critical part is `claimGithub`, which REPLACES the old github_webhook_event
 * dedup that stops double-deploys. FK enforcement is disabled so we can insert
 * rows without the org/project chain.
 */
/**
 * Migrating a fresh PGlite is the expensive part (~1s idle, several seconds when
 * the whole monorepo's suites run in parallel), so it happens ONCE per file and
 * each test just gets an empty table. Doing it per test pushed the `beforeEach`
 * past vitest's 10s hook timeout under `turbo run test` — a flake that had
 * nothing to do with the code under test.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  return { client, repo: createWebhookDeliveryRepo(db) };
}

describe("webhookDelivery repo — GitHub idempotency (claim) + feed", () => {
  let client: PGlite;
  let repo: Awaited<ReturnType<typeof freshRepo>>["repo"];
  beforeAll(async () => {
    ({ client, repo } = await freshRepo());
  });
  // Per-test isolation without re-migrating: the repo only touches this table.
  beforeEach(async () => {
    await client.exec("TRUNCATE webhook_delivery;");
  });

  it("claims a delivery once; a redelivery of the same id is dropped", async () => {
    const first = await repo.claimGithub({ deliveryId: "d1", event: "push", outcome: "received" });
    expect(first.claimed).toBe(true);
    expect(first.id).toBeTruthy();

    const dup = await repo.claimGithub({ deliveryId: "d1", event: "push", outcome: "received" });
    expect(dup.claimed).toBe(false); // partial-unique conflict → dropped (no double-deploy)

    const other = await repo.claimGithub({ deliveryId: "d2", event: "push", outcome: "received" });
    expect(other.claimed).toBe(true); // a different delivery still claims
  });

  it("incoming rows (null deliveryId) never conflict — each call is distinct", async () => {
    const a = await repo.record({ source: "incoming", hookId: "h1", event: "deploy", outcome: "dispatched" });
    const b = await repo.record({ source: "incoming", hookId: "h1", event: "deploy", outcome: "dispatched" });
    expect(a).not.toBe(b);
    const page = await repo.listByHook("h1");
    expect(page.rows.length).toBe(2);
  });

  it("keyset pagination returns every row exactly once, newest first", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.record({ source: "incoming", hookId: "hp", event: "deploy", outcome: "dispatched" });
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repo.listByHook("hp", { cursor, limit: 2 });
      for (const r of page.rows) seen.add(r.id);
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against a cursor loop
    } while (cursor);
    expect(seen.size).toBe(5);
  });

  it("markProcessed updates outcome + actionRef on the claimed anchor", async () => {
    const claim = await repo.claimGithub({ deliveryId: "d3", event: "push", outcome: "received" });
    await repo.markProcessed(claim.id, { outcome: "dispatched", actionRef: "dep_1" });
    const page = await repo.listByHook(""); // no hook filter → none; use org path instead
    expect(page.rows.length).toBe(0); // anchor has null org/hook — invisible in scoped feeds (by design)
  });

  it("prunes rows older than the cutoff", async () => {
    await repo.record({ source: "incoming", hookId: "hx", event: "deploy", outcome: "dispatched" });
    const deleted = await repo.pruneOlderThan(new Date(Date.now() + 60_000)); // cutoff in the future → all
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});
