import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createOrphanedResourceRepo } from "./orphaned-resource.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createOrphanedResourceRepo(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.hostPortClaim);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values({ id: "org", name: "Org" });
});
const create = () =>
  repo.create({
    organizationId: "org",
    projectId: "old",
    resourceType: "route",
    ref: "app.opsh.io",
  });

it("retires a confirmed absent reservation once, preserving a new domain owner", async () => {
  const orphan = await create();
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", organizationId: "org", name: "New", slug: "new" });
  await db
    .insert(schema.project)
    .values({ id: "new", groupId: "group", organizationId: "org", name: "New", slug: "new" });
  await db
    .insert(schema.domain)
    .values({ id: "domain", projectId: "new", hostname: "app.opsh.io" });
  expect(await repo.retireUnboundRoute(orphan)).toBe(true);
  expect(await repo.retireUnboundRoute(orphan)).toBe(false);
  expect(await db.select().from(schema.domain)).toHaveLength(1);
});

it("retains a reservation if its owner is restored after provider inspection", async () => {
  const orphan = await create();
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", organizationId: "org", name: "Old", slug: "old" });
  await db
    .insert(schema.project)
    .values({ id: "old", groupId: "group", organizationId: "org", name: "Old", slug: "old" });
  expect(await repo.retireUnboundRoute(orphan)).toBe(false);
  expect(await repo.listAll()).toHaveLength(1);
});

it("retains intent when physical ownership or cleanup metadata appears after inspection", async () => {
  const orphan = await create();
  await db
    .update(schema.orphanedResource)
    .set({ targetKey: "local" })
    .where(eq(schema.orphanedResource.id, orphan.id));
  expect(await repo.retireUnboundRoute(orphan)).toBe(false);
  await db
    .update(schema.orphanedResource)
    .set({ targetKey: null, payload: { workspaceId: "vm" } })
    .where(eq(schema.orphanedResource.id, orphan.id));
  expect(await repo.retireUnboundRoute(orphan)).toBe(false);
  await db
    .update(schema.orphanedResource)
    .set({ payload: null })
    .where(eq(schema.orphanedResource.id, orphan.id));
  await db
    .insert(schema.hostPortClaim)
    .values({ id: "claim", targetKey: "local", projectId: "old", port: 20000 });
  expect(await repo.retireUnboundRoute(orphan)).toBe(false);
  expect(await repo.listAll()).toHaveLength(1);
});
