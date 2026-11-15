import { beforeAll, afterAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createBackupRunRepo } from "./backup.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createBackupRunRepo(db);
const start = new Date("2026-11-01T00:00:00Z");
beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
  });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.cloudWorkspace).values([
    { id: "cloud", organizationId: "org", name: "Cloud" },
    {
      id: "linked",
      organizationId: "org",
      name: "Linked",
      remote: {
        apiUrl: "https://cloud.test",
        organizationId: "org",
        userId: "user",
        serverId: "server",
        workspaceId: "cloud",
      },
    },
  ]);
  await db.insert(schema.project).values([
    {
      id: "p",
      organizationId: "org",
      groupId: "g",
      name: "P",
      slug: "p",
      workspaceId: "cloud",
      serverId: "managed",
    },
    { id: "ssh", organizationId: "org", groupId: "g-ssh", name: "SSH", slug: "ssh" },
    {
      id: "linked",
      organizationId: "org",
      groupId: "g-linked",
      name: "Linked",
      slug: "linked",
      workspaceId: "linked",
      serverId: "remote",
    },
    {
      id: "bad-workspace-org",
      organizationId: "other",
      groupId: "g-other",
      name: "Bad",
      slug: "bad",
      workspaceId: "cloud",
      serverId: "other",
    },
  ]);
  const terminal = {
    projectId: "p",
    organizationId: "org",
    status: "server_error" as const,
    triggeredBy: "manual" as const,
    executionStartedAt: start,
    finishedAt: start,
    errorMessage: "original failure",
  };
  await db.insert(schema.backupRun).values([
    { ...terminal, id: "a-eligible" },
    { ...terminal, id: "b-eligible" },
    { ...terminal, id: "c-nonterminal", status: "uploading", finishedAt: null },
    { ...terminal, id: "d-finished", executionFinishedAt: start },
    { ...terminal, id: "e-not-started", executionStartedAt: null },
    { ...terminal, id: "f-ssh", projectId: "ssh" },
    { ...terminal, id: "g-linked", projectId: "linked" },
    { ...terminal, id: "h-run-org", organizationId: "other" },
    { ...terminal, id: "i-workspace-org", projectId: "bad-workspace-org", organizationId: "other" },
    { ...terminal, id: "j-deleted", deletedAt: start },
  ]);
});
afterAll(async () => {
  await client.close();
});

it("selects unfinished executions only in an owned SaaS Cloud workspace", async () => {
  expect(await repo.listUnfinishedCloudExecutions()).toEqual([
    { runId: "a-eligible", projectId: "p", organizationId: "org", workspaceId: "cloud" },
    { runId: "b-eligible", projectId: "p", organizationId: "org", workspaceId: "cloud" },
    { runId: "c-nonterminal", projectId: "p", organizationId: "org", workspaceId: "cloud" },
  ]);
});

it("uses a stable cursor beyond the current page", async () => {
  expect((await repo.listUnfinishedCloudExecutions(undefined, 1)).map((r) => r.runId)).toEqual([
    "a-eligible",
  ]);
  expect((await repo.listUnfinishedCloudExecutions("a-eligible", 1)).map((r) => r.runId)).toEqual([
    "b-eligible",
  ]);
});

it("refuses a foreign tenant, moved project, already-finished run and deleted run", async () => {
  for (const input of [
    { runId: "b-eligible", projectId: "p", organizationId: "other" },
    { runId: "b-eligible", projectId: "other", organizationId: "org" },
    ...["d-finished", "e-not-started", "j-deleted"].map((runId) => ({
      runId,
      projectId: "p",
      organizationId: "org",
    })),
  ])
    expect(await repo.acknowledgeRecoveredExecution(input)).toBe(false);
});

it("records an interrupted uploading run without erasing its transfer evidence", async () => {
  await db
    .update(schema.backupRun)
    .set({ bytesTransferred: 1234 })
    .where(eq(schema.backupRun.id, "c-nonterminal"));
  expect(
    await repo.acknowledgeRecoveredExecution({
      runId: "c-nonterminal",
      projectId: "p",
      organizationId: "org",
    }),
  ).toBe(true);
  expect(await repo.findById("c-nonterminal")).toMatchObject({
    status: "server_error",
    executionFinishedAt: expect.any(Date),
    finishedAt: expect.any(Date),
    bytesTransferred: 1234,
    errorMessage: expect.stringContaining("controller was interrupted"),
  });
});

it("closes only the execution acknowledgement and preserves the failed backup verdict", async () => {
  const before = await repo.findById("a-eligible");
  expect(
    await repo.acknowledgeRecoveredExecution({
      runId: "a-eligible",
      projectId: "p",
      organizationId: "org",
    }),
  ).toBe(true);
  const after = await repo.findById("a-eligible");
  expect(after?.executionFinishedAt).toBeInstanceOf(Date);
  expect({ ...after, executionFinishedAt: null }).toEqual(before);
  expect(
    await repo.acknowledgeRecoveredExecution({
      runId: "a-eligible",
      projectId: "p",
      organizationId: "org",
    }),
  ).toBe(false);
  expect(
    (await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, "b-eligible")))[0]
      .executionFinishedAt,
  ).toBeNull();
});
