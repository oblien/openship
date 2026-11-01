import { createEncryption } from "./encryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "./factory";
import { createPgliteLock } from "./pglite-lock";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("instance-owned database composition", () => {
  let first: DatabaseConnection;
  let second: DatabaseConnection;
  beforeAll(async () => {
    [first, second] = await Promise.all([
      createDatabase({ driver: "pglite", dataDir: "memory://" }),
      createDatabase({ driver: "pglite", dataDir: "memory://" }),
    ]);
  }, 30_000);
  afterAll(async () => {
    await Promise.all([first?.close(), second?.close()]);
  });

  it("keeps repositories with the same identifiers isolated and closes only owned resources", async () => {
    await first.db.insert(schema.user).values({ id: "same-user", name: "First", email: "first@example.test" });
    await second.db.insert(schema.user).values({ id: "same-user", name: "Second", email: "second@example.test" });
    const a = createRepositories(first.db, createEncryption("repository-test-secret"));
    const b = createRepositories(second.db, createEncryption("repository-test-secret"));
    expect((await a.user.findById("same-user"))?.name).toBe("First");
    expect((await b.user.findById("same-user"))?.name).toBe("Second");
    await Promise.all([first.close(), first.close()]);
    expect((await b.user.findById("same-user"))?.name).toBe("Second");
    await expect(a.user.findById("same-user")).rejects.toThrow();
  });

  it("requires explicit valid storage instead of falling back to the user's default database", async () => {
    await expect(createDatabase({ driver: "pglite" })).rejects.toThrow("dataDir");
    await expect(createDatabase({ driver: "pg", url: "invalid" })).rejects.toThrow("PostgreSQL");
  });

  it("gives each connection its own PGlite lock without installing process hooks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-owned-locks-"));
    const a = createPgliteLock();
    const b = createPgliteLock();
    const collision = createPgliteLock();
    const before = process.listenerCount("exit");
    try {
      await Promise.all([mkdir(join(directory, "a")), mkdir(join(directory, "b"))]);
      await a.acquire(join(directory, "a"), { waitMs: 0, takeover: false });
      await b.acquire(join(directory, "b"), { waitMs: 0, takeover: false });
      await expect(collision.acquire(join(directory, "a"), { waitMs: 0, takeover: false })).rejects.toThrow("already using");
      a.release();
      await expect(access(join(directory, "a.lock"))).rejects.toThrow();
      await expect(access(join(directory, "b.lock"))).resolves.toBeUndefined();
      expect(process.listenerCount("exit")).toBe(before);
    } finally {
      a.release();
      b.release();
      collision.release();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
