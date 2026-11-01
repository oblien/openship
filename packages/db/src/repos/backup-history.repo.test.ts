import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "../schema";
import { createBackupRunRepo, type NewBackupRun } from "./backup.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const runs = createBackupRunRepo(db);
const startedAt = new Date("2026-09-25T11:04:49.604Z");

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  // These tests exercise history ordering/scoping independently of source lifetimes.
  await client.exec("SET session_replication_role = replica;");
});
beforeEach(async () => {
  await db.delete(schema.backupRun);
  await db.delete(schema.backupPolicy);
  await db.delete(schema.backupDestination);
  await db.delete(schema.service);
  await db.delete(schema.project);
  await db.delete(schema.organization);
});
afterAll(async () => {
  await client.close();
});

async function create(id: string, patch: Partial<NewBackupRun> = {}) {
  await db.insert(schema.backupRun).values({
    id,
    organizationId: "org",
    projectId: "project",
    serviceId: "service",
    status: "succeeded",
    triggeredBy: "manual",
    startedAt,
    ...patch,
  });
}
const ids = (page: { id: string }[]) => page.map((row) => row.id);

it("paginates an entire simultaneous batch without repeats or gaps while new runs and retention change the first page", async () => {
  for (let n = 1; n <= 6; n++) await create(`run-${n}`);
  const first = await runs.listByOrganization("org", { projectId: "project", limit: 2 });
  expect(ids(first)).toEqual(["run-6", "run-5"]);

  await create("new-run", { startedAt: new Date(startedAt.getTime() + 1_000) });
  await db
    .update(schema.backupRun)
    .set({ deletedAt: new Date() })
    .where(eq(schema.backupRun.id, "run-5"));
  const second = await runs.listByOrganization("org", {
    projectId: "project",
    limit: 2,
    before: first.at(-1)!.id,
  });
  expect(ids(second)).toEqual(["run-4", "run-3"]);
  const third = await runs.listByOrganization("org", {
    projectId: "project",
    limit: 2,
    before: second.at(-1)!.id,
  });
  expect(ids(third)).toEqual(["run-2", "run-1"]);
  expect(
    await runs.listByOrganization("org", {
      projectId: "project",
      limit: 2,
      before: third.at(-1)!.id,
    }),
  ).toEqual([]);
});

it("keeps the database's timestamp precision at page boundaries", async () => {
  await create("a-newest");
  await create("z-middle");
  await create("m-oldest");
  await db.execute(sql`UPDATE backup_run SET started_at = CASE id
    WHEN 'a-newest' THEN '2026-09-25 11:04:49.604900'::timestamp
    WHEN 'z-middle' THEN '2026-09-25 11:04:49.604500'::timestamp
    ELSE '2026-09-25 11:04:49.604100'::timestamp END`);
  const first = await runs.listByOrganization("org", { limit: 1 });
  expect(ids(first)).toEqual(["a-newest"]);
  const second = await runs.listByOrganization("org", { limit: 1, before: first[0].id });
  expect(ids(second)).toEqual(["z-middle"]);
  expect(ids(await runs.listByOrganization("org", { limit: 1, before: second[0].id }))).toEqual([
    "m-oldest",
  ]);
});

it("scopes both history and cursors to the requested organization, project, and service", async () => {
  await create("mine-1");
  await create("mine-2");
  await create("deleted", { deletedAt: new Date() });
  await create("foreign-org", { organizationId: "other-org" });
  await create("foreign-project", { projectId: "other-project" });
  await create("foreign-service", { serviceId: "other-service" });
  const scope = { projectId: "project", serviceId: "service", limit: 10 };
  expect(ids(await runs.listByOrganization("org", scope))).toEqual(["mine-2", "mine-1"]);
  expect(ids(await runs.listByOrganization("org", { ...scope, before: "mine-2" }))).toEqual([
    "mine-1",
  ]);
  for (const before of ["foreign-org", "foreign-project", "foreign-service", "unknown"])
    expect(await runs.listByOrganization("org", { ...scope, before })).toEqual([]);
});

it("retains the existing bounded list and offset behavior", async () => {
  for (let n = 1; n <= 4; n++) await create(`run-${n}`);
  expect(ids(await runs.listByOrganization("org", { limit: 2, offset: 2 }))).toEqual([
    "run-2",
    "run-1",
  ]);
});

it("scopes destination pages and cursors without depending on a current policy", async () => {
  await create("mine-1", { destinationId: "store" });
  await create("mine-2", { destinationId: "store" });
  await create("other-storage", { destinationId: "other" });
  await create("foreign", { destinationId: "store", organizationId: "other-org" });
  const first = await runs.listWithSources("org", { destinationId: "store", limit: 1 });
  expect(ids(first)).toEqual(["mine-2"]);
  expect(ids(await runs.listWithSources("org", { destinationId: "store", before: "mine-2" }))).toEqual(["mine-1"]);
  expect(await runs.listWithSources("org", { destinationId: "store", before: "other-storage" })).toEqual([]);
  expect(await runs.listWithSources("org", { destinationId: "store", before: "foreign" })).toEqual([]);
});

it("resolves the actual service and destination of saved runs after their policy is removed", async () => {
  await db.insert(schema.organization).values({ id: "org", name: "Org", slug: "org" });
  await db.insert(schema.project).values({ id: "project", groupId: "group", organizationId: "org", name: "Openship", slug: "openship" });
  await db.insert(schema.service).values({ id: "service", projectId: "project", name: "PostgreSQL" });
  await db.insert(schema.backupDestination).values({ id: "store", organizationId: "org", name: "Production storage", kind: "local" });
  await create("saved", { destinationId: "store", policyId: null });
  expect(await runs.listWithSources("org", { destinationId: "store" })).toMatchObject([{
    id: "saved", projectName: "Openship", serviceName: "PostgreSQL", destinationName: "Production storage", mailServerName: null,
  }]);
  // A forged foreign project id must never disclose its name through a join.
  await db.update(schema.project).set({ organizationId: "foreign" }).where(eq(schema.project.id, "project"));
  expect(await runs.listWithSources("org", { destinationId: "store" })).toMatchObject([{
    id: "saved", projectName: null, serviceName: null,
  }]);
});

it("finds active runs independently of recent completions and continues after a cursor finishes", async () => {
  for (const [index, status] of [
    "queued",
    "preparing",
    "snapshotting",
    "uploading",
    "verifying",
  ].entries())
    await create(`active-${index}`, { status });
  for (const status of ["succeeded", "failed", "cancelled", "server_error"])
    await create(status, { status, startedAt: new Date(startedAt.getTime() + 1000) });
  await create("foreign", { organizationId: "other", status: "uploading" });
  await create("deleted", { status: "uploading", deletedAt: new Date() });
  const scope = { projectId: "project", active: true, limit: 2 };
  expect(ids(await runs.listByOrganization("org", scope))).toEqual(["active-4", "active-3"]);
  await runs.transition("active-3", "succeeded");
  expect(ids(await runs.listByOrganization("org", { ...scope, before: "active-3" }))).toEqual([
    "active-2",
    "active-1",
  ]);
  expect(
    await runs.listByOrganization("org", { projectId: "project", active: false }),
  ).toHaveLength(9);
});
