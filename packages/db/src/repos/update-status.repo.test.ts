import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createUpdateStatusRepo } from "./update-status.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createUpdateStatusRepo(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../../drizzle") });
  await client.exec("SET session_replication_role = replica");
}, 30_000);
beforeEach(() => db.delete(schema.updateStatus));
afterAll(() => client.close());

const old = new Date("2026-09-15T10:00:00Z");
const recent = new Date("2026-09-15T10:11:00Z");
const row = (checkedAt: Date, latestSha: string) => ({
  projectId: "p1",
  organizationId: "org1",
  kind: "commit",
  checkedAt,
  detail: { key: "example/app#main", latestSha },
});

describe("update status cache writes", () => {
  it("does not let a late old poll overwrite a newer result", async () => {
    await repo.upsert(row(recent, "new"));
    await repo.upsert(row(old, "old"));
    expect(await repo.getByProject("p1")).toMatchObject({
      checkedAt: recent,
      detail: { latestSha: "new" },
    });
    await repo.upsert(row(new Date(recent.getTime() + 1), "next"));
    expect(await repo.getByProject("p1")).toMatchObject({ detail: { latestSha: "next" } });
  });

  it("does not let a late unsupported poll delete a newer supported result", async () => {
    await repo.upsert(row(recent, "new"));
    await repo.deleteByProject("p1", old);
    expect(await repo.getByProject("p1")).toBeDefined();
    await repo.deleteByProject("p1", recent);
    expect(await repo.getByProject("p1")).toBeUndefined();
  });

  it("preserves explicit invalidation and keeps cache timeouts local to the write", async () => {
    await repo.upsert(row(recent, "new"));
    await repo.deleteByProject("p1");
    expect(await repo.getByProject("p1")).toBeUndefined();
    expect(
      (await client.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]
        .statement_timeout,
    ).toBe("0");
    expect(
      (await client.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0].lock_timeout,
    ).toBe("0");
  });
});
