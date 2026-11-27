import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createDatabase,
  createRepositories,
  eq,
  schema,
  type DatabaseConnection,
} from "../factory";

let connection: DatabaseConnection;
let repos: ReturnType<typeof createRepositories>;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repos = createRepositories(connection.db, { encrypt: (v) => v, decrypt: (v) => v });
  await connection.db
    .insert(schema.organization)
    .values(["a", "b"].map((id) => ({ id, name: id })));
}, 60_000);
afterAll(() => connection?.close());

it("reserves each engine and organization once, and quarantines deleted owners' inboxes", async () => {
  const repo = repos.managedMail;
  const claim = (org: string, id: string, engine: string) =>
    repo.claim({
      organizationId: org,
      id,
      engine,
      hostname: engine + ".example",
      placement: "standard",
    });
  const results = await Promise.all([claim("a", "one", "engine"), claim("b", "two", "engine")]);
  const winner = results.find(Boolean)!;
  expect(results.filter(Boolean)).toHaveLength(1);
  const org = winner.organizationId!;
  expect(await repo.owner(winner.id)).toBe(org);
  expect(await claim(org, "three", "spare")).toBeNull();
  expect(await repo.occupied("spare", "spare.example")).toBe(false);
  await repo.ensureAccount(org, "private-mail");
  await repo.updateAccount(org, { checkout: { plan: "solo", key: "key" } });
  expect(await repo.billingOwner("private-mail")).toMatchObject({
    organizationId: org,
    checkout: { key: "key" },
  });
  await connection.db.delete(schema.organization).where(eq(schema.organization.id, org));
  expect(await repo.owner(winner.id)).toBeNull();
  expect(await repo.occupied("new-worker-origin", "engine.example")).toBe(true);
  expect(await claim(org === "a" ? "b" : "a", "four", "engine")).toBeNull();
  expect(await repo.billingOwner("private-mail")).toBeUndefined();
});

it("shares an explicitly shared host across organizations and prevents changing its identity or mode", async () => {
  const ids = ["shared-a", "shared-b", "shared-c"];
  await connection.db.insert(schema.organization).values(ids.map(id => ({ id, name: id })));
  const claim = (org: string, shared: boolean, engine = "pool") => repos.managedMail.claim({
    id: org, organizationId: org, shared, engine, placement: "standard", hostname: "mail.pool.test",
  });
  expect((await Promise.all(ids.slice(0, 2).map(org => claim(org, true)))).every(Boolean)).toBe(true);
  expect(await claim(ids[2]!, false)).toBeNull();
  expect(await claim(ids[2]!, true, "renamed")).toBeNull();
  expect(await repos.managedMail.occupied("pool", "mail.pool.test", true)).toBe(false);
  expect(await repos.managedMail.occupied("pool", "mail.pool.test")).toBe(true);
});
