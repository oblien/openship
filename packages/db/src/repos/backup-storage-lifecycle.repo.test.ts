import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import {
  createBackupDestinationRepo,
  createBackupPolicyRepo,
  createBackupRestoreRepo,
  createBackupRunRepo,
} from "./backup.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const destinations = createBackupDestinationRepo(db);
const policies = createBackupPolicyRepo(db);
const runs = createBackupRunRepo(db);
const restores = createBackupRestoreRepo(db);
const run = (id: string) => ({
  id,
  organizationId: "org",
  projectId: "project",
  destinationId: "storage",
  triggeredBy: "manual",
  status: "queued",
});

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica");
  await db.insert(schema.organization).values([
    { id: "org", name: "Backups", slug: "backups" },
    { id: "foreign", name: "Foreign", slug: "foreign" },
  ]);
  await db
    .insert(schema.project)
    .values(
      ["project", "other-project"].map((id) => ({
        id,
        groupId: `group-${id}`,
        organizationId: "org",
        name: id,
        slug: id,
      })),
    );
  await db.insert(schema.servers).values([
    { id: "mail-a", organizationId: "org", sshHost: "mail-a.test" },
    { id: "mail-b", organizationId: "org", sshHost: "mail-b.test" },
    { id: "foreign-mail", organizationId: "foreign", sshHost: "foreign.test" },
  ]);
  await db.insert(schema.mailServers).values([
    { serverId: "mail-a", domain: "mail-a.test" },
    { serverId: "mail-b", domain: "mail-b.test" },
    { serverId: "foreign-mail", domain: "foreign.test" },
  ]);
  await client.exec("SET session_replication_role = origin");
}, 30_000);
afterAll(async () => client.close());
beforeEach(async () => {
  await db.delete(schema.backupRestore);
  await db.delete(schema.backupRun);
  await db.delete(schema.backupPolicy);
  await db.delete(schema.backupDestination);
  await db
    .update(schema.project)
    .set({ deletionInProgress: false })
    .where(eq(schema.project.id, "project"));
  await db.insert(schema.backupDestination).values([
    {
      id: "storage",
      organizationId: "org",
      name: "Storage",
      kind: "sftp",
      sshHost: "storage.test",
      sshUser: "backup",
      pathPrefix: "/backups",
    },
    { id: "next", organizationId: "org", name: "Next", kind: "local", endpoint: "/next" },
    {
      id: "foreign",
      organizationId: "foreign",
      name: "Foreign",
      kind: "local",
      endpoint: "/foreign",
    },
  ]);
});

describe("exclusive restore targets", () => {
  async function prepare(
    id: string,
    target: { projectId: string } | { mailServerId: string; forkMailServerId?: string },
  ) {
    const projectId = "projectId" in target ? target.projectId : null;
    const source = await runs.create({
      ...run(`source-${id}`),
      projectId,
      status: "succeeded",
      sourceKind: projectId ? "service" : "mail_server",
      mailServerId: "mailServerId" in target ? target.mailServerId : null,
    });
    return restores.create({
      id,
      runId: source.id,
      projectId,
      organizationId: "org",
      destinationId: "storage",
      status: "prepared",
      mode: "forkMailServerId" in target ? "to_fork" : "in_place",
      forkMailServerId: "forkMailServerId" in target ? target.forkMailServerId : null,
    });
  }

  it("admits one of two different backups targeting the same project and keeps the loser retryable", async () => {
    const rows = await Promise.all([
      prepare("first", { projectId: "project" }),
      prepare("second", { projectId: "project" }),
    ]);
    const claims = await Promise.all(
      rows.map((row) => restores.claimApply(row.id, row.projectId, row.organizationId)),
    );
    expect([...claims].sort()).toEqual(["claimed", "target_busy"]);
    const winner = rows[claims.indexOf("claimed")]!;
    const pending = rows[claims.indexOf("target_busy")]!;
    expect(await restores.findById(pending.id)).toMatchObject({ status: "prepared" });

    // A cancel request alone is not proof that the current writer has stopped.
    await restores.requestCancel(winner.id);
    await expect(restores.claimApply(pending.id, "project", "org")).resolves.toBe("target_busy");
    await restores.transition(winner.id, "cancelled");
    await expect(restores.claimApply(pending.id, "project", "org")).resolves.toBe("claimed");
  });

  it("allows restores into separate projects and rejects duplicate apply of the same row", async () => {
    const rows = await Promise.all([
      prepare("first", { projectId: "project" }),
      prepare("second", { projectId: "other-project" }),
    ]);
    expect(
      await Promise.all(rows.map((row) => restores.claimApply(row.id, row.projectId, "org"))),
    ).toEqual(["claimed", "claimed"]);
    await expect(restores.claimApply(rows[0]!.id, "project", "org")).resolves.toBe("state_changed");
  });

  it("serializes in-place mail restores with a migration onto the same server", async () => {
    const rows = await Promise.all([
      prepare("in-place", { mailServerId: "mail-b" }),
      prepare("migration", { mailServerId: "mail-a", forkMailServerId: "mail-b" }),
    ]);
    const claims = await Promise.all(rows.map((row) => restores.claimApply(row.id, null, "org")));
    expect([...claims].sort()).toEqual(["claimed", "target_busy"]);

    const independent = await prepare("independent", { mailServerId: "mail-a" });
    await expect(restores.claimApply(independent.id, null, "org")).resolves.toBe("claimed");
    const winner = rows[claims.indexOf("claimed")]!;
    const pending = rows[claims.indexOf("target_busy")]!;
    await restores.transition(winner.id, "succeeded");
    await expect(restores.claimApply(pending.id, null, "org")).resolves.toBe("claimed");
  });

  it("refuses a missing or foreign mail target before applying", async () => {
    const foreign = await prepare("foreign-target", {
      mailServerId: "mail-a",
      forkMailServerId: "foreign-mail",
    });
    await expect(restores.claimApply(foreign.id, null, "org")).resolves.toBe("target_unavailable");
    expect(await restores.findById(foreign.id)).toMatchObject({ status: "prepared" });

    const missing = await prepare("missing-target", { mailServerId: "mail-a" });
    await db
      .update(schema.backupRun)
      .set({ mailServerId: null })
      .where(eq(schema.backupRun.id, missing.runId));
    await expect(restores.claimApply(missing.id, null, "org")).resolves.toBe("target_unavailable");
    expect(await restores.findById(missing.id)).toMatchObject({ status: "prepared" });

    // Deleting a migration target clears its FK; it must never fall back to
    // restoring the source mail server instead.
    const missingFork = await prepare("missing-fork", {
      mailServerId: "mail-a",
      forkMailServerId: "mail-b",
    });
    await db
      .update(schema.backupRestore)
      .set({ forkMailServerId: null })
      .where(eq(schema.backupRestore.id, missingFork.id));
    await expect(restores.claimApply(missingFork.id, null, "org")).resolves.toBe("target_unavailable");
    expect(await restores.findById(missingFork.id)).toMatchObject({ status: "prepared" });
  });

  it("resolves an in-place target by its mode even if an unused fork id was recorded", async () => {
    const first = await prepare("in-place", { mailServerId: "mail-a" });
    await db
      .update(schema.backupRestore)
      .set({ forkMailServerId: "mail-b" })
      .where(eq(schema.backupRestore.id, first.id));
    await restores.claimApply(first.id, null, "org");
    const second = await prepare("same-target", { mailServerId: "mail-a" });
    await expect(restores.claimApply(second.id, null, "org")).resolves.toBe("target_busy");
  });
});

describe("atomic backup admission and storage ownership", () => {
  it("rolls back the entire batch if any row cannot be inserted", async () => {
    await expect(runs.createBatch([run("duplicate"), run("duplicate")])).rejects.toThrow();
    expect(await runs.listByOrganization("org")).toEqual([]);
  });

  it("refuses the whole batch when a destination is unavailable or belongs to another organization", async () => {
    await expect(
      runs.createBatch([run("first"), { ...run("second"), destinationId: "foreign" }]),
    ).rejects.toThrow(/destination.*available/);
    expect(await runs.listByOrganization("org")).toEqual([]);
    await destinations.softDelete("storage");
    await expect(runs.createBatch([run("first"), run("second")])).rejects.toThrow(
      /destination.*available/,
    );
    expect(await runs.listByOrganization("org")).toEqual([]);
  });

  it("does not admit any child after project deletion starts", async () => {
    await db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, "project"));
    await expect(runs.createBatch([run("first"), run("second")])).rejects.toThrow(
      /project is being deleted/,
    );
    expect(await runs.listByOrganization("org")).toEqual([]);
  });

  it("serializes destination deletion with a new queued backup", async () => {
    const [created, removed] = await Promise.allSettled([
      runs.create(run("racing")),
      destinations.softDelete("storage"),
    ]);
    expect(removed.status).toBe("fulfilled");
    if (created.status === "fulfilled") {
      expect(removed).toMatchObject({ status: "fulfilled", value: { ok: false } });
      expect(await destinations.findById("storage")).toBeDefined();
    } else {
      expect(removed).toMatchObject({ status: "fulfilled", value: { ok: true } });
      expect(await runs.findById("racing")).toBeUndefined();
    }
  });

  it("keeps retained storage pinned after a policy moves, while allowing credential rotation", async () => {
    await policies.create({ id: "policy", projectId: "project", destinationId: "storage" });
    await runs.create({ ...run("retained"), policyId: "policy", status: "succeeded" });
    await policies.update("policy", { destinationId: "next" });
    await expect(destinations.update("storage", { pathPrefix: "/elsewhere" })).rejects.toThrow(
      /original storage address/,
    );
    await expect(destinations.update("storage", { sshHost: "other.test" })).rejects.toThrow(
      /original storage address/,
    );
    expect(await destinations.softDelete("storage")).toMatchObject({ ok: false });
    expect(
      await destinations.update("storage", { name: "Renamed", sftpPasswordEnc: "rotated" }),
    ).toMatchObject({ name: "Renamed", sftpPasswordEnc: "rotated" });
    await runs.softDelete("retained");
    expect(await destinations.softDelete("storage")).toEqual({ ok: true });
  });

  it("admits only one default policy when two creates arrive together", async () => {
    const results = await Promise.allSettled(
      ["one", "two"].map((id) =>
        policies.create({ id, projectId: "project", destinationId: "storage" }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await policies.listByProject("project")).toHaveLength(1);
    const existing = (await policies.findProjectDefault("project"))!;
    await policies.softDelete(existing.id);
    expect(
      await policies.create({ id: "replacement", projectId: "project", destinationId: "storage" }),
    ).toBeDefined();
  });

  it("serializes a policy's destination change with storage deletion", async () => {
    await policies.create({ id: "policy", projectId: "project", destinationId: "storage" });
    const [moved, removed] = await Promise.allSettled([
      policies.update("policy", { destinationId: "next" }),
      destinations.softDelete("next"),
    ]);
    if (moved.status === "fulfilled") {
      expect(moved.value?.destinationId).toBe("next");
      expect(removed).toMatchObject({ status: "fulfilled", value: { ok: false } });
      expect(await destinations.findById("next")).toBeDefined();
    } else {
      expect(removed).toMatchObject({ status: "fulfilled", value: { ok: true } });
      expect((await policies.findById("policy"))?.destinationId).toBe("storage");
    }
    await expect(policies.update("policy", { destinationId: "foreign" })).rejects.toThrow(
      /destination.*available/,
    );
  });

  it("preserves legacy storage estimates alongside newer artifact records", async () => {
    await runs.create({
      ...run("legacy"),
      status: "succeeded",
      artifacts: [],
      bytesTransferred: 500,
    });
    expect(await runs.statsByDestination("org")).toMatchObject([{ storedBytes: 500 }]);
    await runs.create({
      ...run("current"),
      status: "succeeded",
      artifacts: [{ key: "current/data.tar", sizeBytes: 700 }],
      bytesTransferred: 700,
    });
    expect(await runs.statsByDestination("org")).toMatchObject([
      { storedBytes: 1200, runCount: 2 },
    ]);
  });

  it("distinguishes saved backups from active, failed and cancelled attempts within one organization", async () => {
    const statuses = ["succeeded", "succeeded", "queued", "preparing", "snapshotting", "uploading", "verifying", "failed", "server_error", "cancelled"];
    await db.insert(schema.backupRun).values(statuses.map((status, index) => ({
      ...run(`attempt-${index}`), status, bytesTransferred: 500,
      startedAt: new Date(`2026-09-25T11:00:${String(index).padStart(2, "0")}Z`),
    })));
    await db.insert(schema.backupRun).values([
      { ...run("pruned-success"), status: "succeeded", bytesTransferred: 1000, deletedAt: new Date() },
      { ...run("foreign-success"), organizationId: "foreign", destinationId: "foreign", projectId: null, status: "succeeded", bytesTransferred: 2000 },
    ]);
    expect(await runs.statsByDestination("org")).toEqual([{
      destinationId: "storage", storedBytes: 1000, runCount: 10,
      savedCount: 2, activeCount: 5, failedCount: 2, cancelledCount: 1,
      lastRunAt: new Date("2026-09-25T11:00:09Z"),
    }]);
    await runs.transition("attempt-5", "succeeded");
    expect(await runs.statsByDestination("org")).toMatchObject([{
      storedBytes: 1500, savedCount: 3, activeCount: 4, failedCount: 2, cancelledCount: 1,
    }]);
  });

  it("counts a block once and keeps counting it after its original run is pruned", async () => {
    const artifact = (key: string) => ({
      key,
      sizeBytes: 2000,
      sha256: "a".repeat(64),
      metadata: {
        storage: {
          format: "chunks-v1",
          indexSizeBytes: 100,
          indexSha256: "b".repeat(64),
          uploadedBytes: 1100,
          chunks: [
            {
              key: "old/blocks/data.gz",
              sizeBytes: 1000,
              sha256: "c".repeat(64),
              contentBytes: 2000,
              contentSha256: "d".repeat(64),
            },
          ],
        },
      },
    });
    await runs.create({
      ...run("first"),
      status: "succeeded",
      artifacts: [artifact("first/index")],
      bytesTransferred: 1100,
    });
    await runs.create({
      ...run("second"),
      status: "succeeded",
      artifacts: [artifact("second/index")],
      bytesTransferred: 100,
    });
    expect(await runs.statsByDestination("org")).toMatchObject([
      { storedBytes: 1200, runCount: 2 },
    ]);
    await runs.softDelete("first");
    expect(await runs.statsByDestination("org")).toMatchObject([
      { storedBytes: 1100, runCount: 1 },
    ]);
  });
});
