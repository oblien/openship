import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createPersonalAccessTokenRepo } from "./personal-access-token.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) test for the credential usage stamp.
 *
 * `last_used_at` answered "is this still in use". It could not answer "how much",
 * which is the difference between an agent someone tried once and one running
 * unattended — so the settings UI could show a connection as active without any
 * sense of scale. The counter rides along in the same UPDATE, and being SQL rather
 * than read-modify-write is the whole point under a burst of concurrent tool calls,
 * which is what a mock would hide.
 *
 * FK enforcement is off so a token can exist without the user/org chain.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  return { client, db, repo: createPersonalAccessTokenRepo(db) };
}

let repo: Awaited<ReturnType<typeof freshRepo>>["repo"];
let seq = 0;

async function newToken(): Promise<string> {
  const row = await repo.create({
    userId: "u1",
    organizationId: "org1",
    name: `token-${seq}`,
    tokenPrefix: `opsh_pat_${seq}`,
    tokenHash: `hash-${seq++}`,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  return row.id;
}

beforeAll(async () => {
  ({ repo } = await freshRepo());
});

describe("touchLastUsed", () => {
  it("starts a fresh credential at zero, never null", async () => {
    const id = await newToken();
    const rows = await repo.listByUser("u1");
    expect(rows.find((r) => r.id === id)?.useCount).toBe(0);
  });

  it("stamps the timestamp and advances the count together", async () => {
    const id = await newToken();
    await repo.touchLastUsed(id);
    const [row] = (await repo.listByUser("u1")).filter((r) => r.id === id);
    expect(row?.useCount).toBe(1);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("counts every call, not just the first", async () => {
    const id = await newToken();
    for (let i = 0; i < 5; i++) await repo.touchLastUsed(id);
    const row = (await repo.listByUser("u1")).find((r) => r.id === id);
    expect(row?.useCount).toBe(5);
  });

  it("loses nothing when calls overlap", async () => {
    // An agent fires tool calls concurrently; a read-modify-write here would
    // interleave and under-count.
    const id = await newToken();
    await Promise.all(Array.from({ length: 20 }, () => repo.touchLastUsed(id)));
    const row = (await repo.listByUser("u1")).find((r) => r.id === id);
    expect(row?.useCount).toBe(20);
  });

  it("counts per credential — one agent's traffic is not another's", async () => {
    const a = await newToken();
    const b = await newToken();
    await repo.touchLastUsed(a);
    await repo.touchLastUsed(a);
    await repo.touchLastUsed(b);
    const rows = await repo.listByUser("u1");
    expect(rows.find((r) => r.id === a)?.useCount).toBe(2);
    expect(rows.find((r) => r.id === b)?.useCount).toBe(1);
  });
});

describe("listNamesByIds", () => {
  it("labels the tokens an audit row can be attributed to", async () => {
    // `pat:<id>` rows have no OAuth application to name them, so without this the
    // audit feed shows a raw pat_ id where the client name belongs.
    const id = await newToken();
    const names = await repo.listNamesByIds([id]);
    expect(names).toEqual([{ id, name: expect.stringMatching(/^token-/) }]);
  });

  it("is empty for no ids, and skips ids that do not exist", async () => {
    expect(await repo.listNamesByIds([])).toEqual([]);
    expect(await repo.listNamesByIds(["pat_missing"])).toEqual([]);
  });
});
