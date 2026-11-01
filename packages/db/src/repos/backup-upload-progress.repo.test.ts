import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createBackupRunRepo } from "./backup.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const run = createBackupRunRepo(db);
const previousHeartbeat = new Date("2026-01-01T00:00:00Z");

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await db.insert(schema.organization).values({ id: "org-progress", name: "Progress", slug: "progress" });
});
afterAll(async () => { await client.close(); });
beforeEach(async () => { await db.delete(schema.backupRun); });

async function create(status: typeof schema.backupRun.$inferInsert.status = "uploading") {
  await db.insert(schema.backupRun).values({
    id: "progress-run", organizationId: "org-progress", status,
    triggeredBy: "manual", lastEventAt: previousHeartbeat,
  });
}

it("advances bytes and the heartbeat without changing status or finishing the run", async () => {
  await create();
  expect(await run.recordUploadProgress("progress-run", 1_048_576)).toBe(true);
  const row = await run.findById("progress-run");
  expect(row).toMatchObject({ status: "uploading", bytesTransferred: 1_048_576, finishedAt: null });
  expect(row!.lastEventAt.getTime()).toBeGreaterThan(previousHeartbeat.getTime());
});

it("keeps the greatest count when advancing, duplicated and older writes race", async () => {
  await create();
  await Promise.all([300, 100, 300, 500, 200].map(bytes => run.recordUploadProgress("progress-run", bytes)));
  expect((await run.findById("progress-run"))!.bytesTransferred).toBe(500);
  const heartbeat = (await run.findById("progress-run"))!.lastEventAt;
  expect(await run.recordUploadProgress("progress-run", 400)).toBe(false);
  expect(await run.recordUploadProgress("progress-run", 500)).toBe(false);
  expect((await run.findById("progress-run"))!.lastEventAt).toEqual(heartbeat);
});

it.each(["queued", "preparing", "snapshotting", "verifying", "succeeded", "failed", "cancelled", "server_error"] as const)(
  "does not change or heartbeat a %s run", async status => {
    await create(status);
    expect(await run.recordUploadProgress("progress-run", 100)).toBe(false);
    expect(await run.findById("progress-run")).toMatchObject({ status, bytesTransferred: null, lastEventAt: previousHeartbeat });
  },
);

it("refuses missing runs", async () => {
  expect(await run.recordUploadProgress("missing", 100)).toBe(false);
});

it("preserves the first terminal verdict and its exact bytes against later writes", async () => {
  await create();
  await run.recordUploadProgress("progress-run", 100);
  expect(await run.transition("progress-run", "succeeded", { bytesTransferred: 200 })).toBe(true);
  const finished = await run.findById("progress-run");
  expect(await run.transition("progress-run", "failed", { bytesTransferred: 0 })).toBe(false);
  expect(await run.recordUploadProgress("progress-run", 300)).toBe(false);
  expect(await run.findById("progress-run")).toEqual(finished);
});
