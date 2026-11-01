import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, isNotNull } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createServerClusterRepo } from "./server-cluster.repo";
import { createComputeClusterRepo } from "./compute-cluster.repo";
import { createClusterRuntimeRepo } from "./cluster-runtime.repo";
import { createClusterDatabaseRepo } from "./cluster-database.repo";
import { createClusterStorageRepo } from "./cluster-storage.repo";
import { createBackupDestinationRepo } from "./backup.repo";
import { clusterRuntimePlanFixture } from "../../../contracts/test/cluster-runtime-fixtures";
import type { ClusterDatabaseConfig, ClusterDatabaseObservation } from "@repo/core";
import { CLUSTER_STORAGE_STEPS, type ClusterStorageProgress } from "@repo/core";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const networks = createServerClusterRepo(db),
  clusters = createComputeClusterRepo(db),
  runtimes = createClusterRuntimeRepo(db),
  databases = createClusterDatabaseRepo(db);
const storage = createClusterStorageRepo(db);
const config: ClusterDatabaseConfig = {
  engine: "postgres",
  mode: "standalone",
  instances: 1,
  storageGiB: 10,
  storageClass: "openship-local",
  cpuMillis: 500,
  memoryMiB: 512,
  databaseName: "app",
};
const observation: ClusterDatabaseObservation = {
  ready: true,
  message: "Verified",
  observedAt: new Date().toISOString(),
  primary: "database-1",
  pods: [],
  volumes: [],
};
let clusterId: string, runtimeId: string;
const input = () => ({
  organizationId: "org",
  projectId: "project",
  clusterId,
  runtimeId,
  name: "postgres",
  requestId: "request-one",
  config,
  secretEncrypted: "encrypted-password",
});
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => client.close());
beforeEach(async () => {
  await db.delete(schema.project);
  await db.delete(schema.servers).where(isNotNull(schema.servers.workspaceId));
  await db.delete(schema.cloudWorkspace);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org", name: "Org" },
    { id: "other", name: "Other" },
  ]);
  await db
    .insert(schema.servers)
    .values(["a", "b", "c"].map((id) => ({ id, organizationId: "org", sshHost: id })));
  const plan = clusterRuntimePlanFixture();
  const network = await networks.create(
    "org",
    {
      name: "Network",
      network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
      members: plan.hosts.map((host) => ({
        serverId: host.serverId,
        privateIp: host.privateIp,
        providerId: "custom" as const,
      })),
    },
    "network",
    "hash",
  );
  const cluster = await clusters.create(
    "org",
    { name: "Cluster", networkId: network.id, serverIds: ["a", "b", "c"] },
    "cluster",
    "hash",
  );
  clusterId = cluster.id;
  plan.networkId = network.id;
  plan.clusterUid = "kube-uid";
  const runtime = await runtimes.start(
    "org",
    cluster.id,
    cluster.revision,
    "runtime-request",
    plan,
  );
  runtimeId = runtime.row.id;
  for (const host of plan.hosts) {
    host.ready = true;
    host.installed = true;
    for (const step of host.steps) step.status = "completed";
  }
  await runtimes.finish(runtimeId, 1, plan, "setup", null);
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", organizationId: "org", name: "API", slug: "api" });
  await db.insert(schema.project).values({
    id: "project",
    groupId: "group",
    organizationId: "org",
    name: "API",
    slug: "api",
    clusterId,
    clusterConfig: { replicas: 1 },
  });
});

describe("durable project databases", () => {
  it("reuses an identical request after an ambiguous response and rejects changed intent", async () => {
    const first = await databases.start(input());
    expect(first.started).toBe(true);
    const second = await databases.start({ ...input(), config: { ...config, engine: "postgres" } });
    expect(second.started).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    await expect(databases.start({ ...input(), name: "another" })).rejects.toThrow("already used");
    await expect(databases.start({ ...input(), requestId: "request-two" })).rejects.toThrow(
      "already uses",
    );
  });
  it("scopes reads and refuses a project that moved to a cloud workspace", async () => {
    const { row } = await databases.start(input());
    await expect(databases.get("other", "project", row.id)).rejects.toThrow();
    expect(await databases.list("other", "project")).toEqual([]);
    await db.insert(schema.cloudWorkspace).values({ id: "cloud-workspace", name: "Managed", organizationId: "org" });
    await db.insert(schema.servers).values({ id: "cloud-server", name: "Managed", organizationId: "org", workspaceId: "cloud-workspace" });
    await db
      .update(schema.project)
      .set({ clusterId: null, serverId: "cloud-server" })
      .where(eq(schema.project.id, "project"));
    await expect(
      databases.start({ ...input(), requestId: "another", name: "another" }),
    ).rejects.toThrow("cluster changed");
  });
  it("prepares a database while the app stays on Docker, then allows that cluster to be selected", async () => {
    await db
      .update(schema.project)
      .set({ clusterId: null, clusterConfig: null })
      .where(eq(schema.project.id, "project"));
    const { row } = await databases.start(input());
    expect(row.clusterId).toBe(clusterId);
    const [before] = await db.select().from(schema.project).where(eq(schema.project.id, "project"));
    expect(before.clusterId).toBeNull();
    const after = await runtimes.bindProject(
      "org",
      "project",
      clusterId,
      { replicas: 2 },
      before.updatedAt.toISOString(),
    );
    expect(after.clusterId).toBe(clusterId);
    await expect(
      runtimes.bindProject("org", "project", null, null, after.updatedAt.toISOString()),
    ).rejects.toThrow(/owns databases/);
  });
  it("recovers interrupted attempts without restarting them, then fences the old worker", async () => {
    const { row } = await databases.start(input());
    await db
      .update(schema.clusterDatabase)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.clusterDatabase.id, row.id));
    const interrupted = await databases.get("org", "project", row.id);
    expect(interrupted.status).toBe("interrupted");
    const retry = await databases.change("org", "project", row.id, interrupted.sequence, "retry");
    expect(retry.generation).toBe(2);
    expect(await databases.finish(row.id, 1, "ready", observation, null)).toBe(false);
    expect(await databases.heartbeat(row.id, 1)).toBe(false);
    await expect(databases.progress(row.id, 1, { steps: [], logs: [] })).rejects.toThrow(
      "no longer owns",
    );
  });
  it("serializes mutations and does not accept readiness before verification", async () => {
    const { row } = await databases.start(input());
    await expect(
      databases.change("org", "project", row.id, row.sequence, "remove"),
    ).rejects.toThrow("already running");
    await expect(databases.finish(row.id, row.generation, "ready", null, null)).rejects.toThrow(
      "verification",
    );
    await databases.finish(row.id, 1, "ready", observation, null);
    await expect(
      databases.change("org", "project", row.id, row.sequence, "remove"),
    ).rejects.toThrow("changed");
  });
  it("continues permanent cleanup after failure instead of promising to retain already-deleted data", async () => {
    const { row } = await databases.start(input());
    await databases.finish(row.id, 1, "failed", null, "Interrupted setup");
    const failed = await databases.get("org", "project", row.id);
    const removing = await databases.change("org", "project", row.id, failed.sequence, "remove", {
      deleteData: true,
    });
    await databases.finish(
      row.id,
      removing.generation,
      "failed",
      null,
      "Waiting for namespace cleanup",
    );
    const interrupted = await databases.get("org", "project", row.id);
    await expect(
      databases.change("org", "project", row.id, interrupted.sequence, "remove", {
        deleteData: false,
      }),
    ).rejects.toThrow("Permanent data deletion has already started");
    expect(
      await databases.change("org", "project", row.id, interrupted.sequence, "retry"),
    ).toMatchObject({ intent: "remove", deleteData: true, status: "deleting" });
  });
  it("does not overwrite an existing variable or delete a user's replacement on disconnect", async () => {
    const { row } = await databases.start(input());
    await databases.finish(row.id, 1, "ready", observation, null);
    let current = await databases.get("org", "project", row.id);
    await db.insert(schema.envVar).values({
      id: "existing",
      projectId: "project",
      key: "DATABASE_URL",
      value: "existing-secret",
      environment: "production",
    });
    await expect(
      databases.connect("org", "project", row.id, current.sequence, "DATABASE_URL", "new-secret"),
    ).rejects.toThrow("already exists");
    current = await databases.connect(
      "org",
      "project",
      row.id,
      current.sequence,
      "APP_DB",
      "owned-secret",
    );
    await expect(
      databases.change("org", "project", row.id, current.sequence, "remove"),
    ).rejects.toThrow("Disconnect");
    await db
      .update(schema.envVar)
      .set({ value: "user-replacement" })
      .where(eq(schema.envVar.key, "APP_DB"));
    await databases.connect("org", "project", row.id, current.sequence, null, null);
    const vars = await db.select().from(schema.envVar);
    expect(vars.map((item) => item.value).sort()).toEqual(["existing-secret", "user-replacement"]);
  });
  it("prevents moving the project while it owns databases, including retained data", async () => {
    const { row } = await databases.start(input());
    await databases.finish(row.id, 1, "ready", observation, null);
    const [p] = await db.select().from(schema.project).where(eq(schema.project.id, "project"));
    await expect(
      runtimes.bindProject("org", "project", null, null, p!.updatedAt.toISOString()),
    ).rejects.toThrow("still owns databases");
    const current = await databases.get("org", "project", row.id);
    const removing = await databases.change("org", "project", row.id, current.sequence, "remove");
    await databases.finish(row.id, removing.generation, "retained", null, null);
    await expect(
      runtimes.bindProject("org", "project", null, null, p!.updatedAt.toISOString()),
    ).rejects.toThrow("still owns databases");
  });
  it("retains one backup request identity across a controller restart", async () => {
    await db.insert(schema.backupDestination).values({
      id: "s3",
      organizationId: "org",
      name: "Archives",
      kind: "s3_compatible",
      bucket: "backups",
      accessKeyIdEnc: "key",
      secretAccessKeyEnc: "secret",
    });
    const settings = {
      ...config,
      backup: { destinationId: "s3", schedule: "daily" as const, retentionDays: 30 },
    };
    const { row } = await databases.start({ ...input(), config: settings });
    expect(
      (
        await databases.start({
          ...input(),
          config: {
            ...settings,
            backup: { retentionDays: 30, schedule: "daily", destinationId: "s3" },
          },
        })
      ).started,
    ).toBe(false);
    await databases.finish(row.id, 1, "ready", observation, null);
    const ready = await databases.get("org", "project", row.id);
    const backup = await databases.change("org", "project", row.id, ready.sequence, "backup");
    expect(backup.intent).toBe("backup");
    expect(backup.backupRequestId).toBeTruthy();
    await db
      .update(schema.clusterDatabase)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.clusterDatabase.id, row.id));
    const interrupted = await databases.get("org", "project", row.id);
    const retry = await databases.change("org", "project", row.id, interrupted.sequence, "retry");
    expect(retry.intent).toBe("backup");
    expect(retry.backupRequestId).toBe(backup.backupRequestId);
    expect(await databases.finish(row.id, backup.generation, "ready", observation, null)).toBe(
      false,
    );
  });
  it("protects a live database's archive address and scopes destinations to its organization", async () => {
    const destinations = createBackupDestinationRepo(db);
    await destinations.create({
      id: "s3",
      organizationId: "other",
      name: "Archives",
      kind: "s3_compatible",
      bucket: "backups",
      accessKeyIdEnc: "key",
      secretAccessKeyEnc: "secret",
    });
    const settings = {
      ...config,
      backup: { destinationId: "s3", schedule: "daily" as const, retentionDays: 30 },
    };
    await expect(databases.start({ ...input(), config: settings })).rejects.toThrow(
      /available.*destination/,
    );
    await db
      .update(schema.backupDestination)
      .set({ organizationId: "org" })
      .where(eq(schema.backupDestination.id, "s3"));
    const { row } = await databases.start({ ...input(), config: settings });
    await expect(destinations.update("s3", { bucket: "elsewhere" })).rejects.toThrow(
      "recovery archives",
    );
    expect(await destinations.softDelete("s3")).toMatchObject({ ok: false });
    await databases.finish(row.id, 1, "ready", observation, null);
    const ready = await databases.get("org", "project", row.id);
    const removing = await databases.change("org", "project", row.id, ready.sequence, "remove", {
      deleteData: true,
    });
    await databases.finish(row.id, removing.generation, "deleted", null, null);
    expect(await destinations.softDelete("s3")).toEqual({ ok: true });
  });
});

describe("durable shared storage", () => {
  const storageInput = () => ({
    organizationId: "org",
    clusterId,
    runtimeId,
    requestId: "storage-request",
    config: {
      replicas: 2,
      disks: ["a", "b", "c"].map((serverId) => ({
        serverId,
        path: "/var/lib/openship/storage",
        reservedGiB: 5,
      })),
    },
  });
  const progress = (): ClusterStorageProgress => ({
    steps: CLUSTER_STORAGE_STEPS.map((id) => ({
      id,
      status: "completed",
      message: "Verified",
      startedAt: null,
      finishedAt: null,
    })),
    logs: [],
  });
  const healthy = () => ({
    observedAt: new Date().toISOString(),
    ready: true,
    nodes: [],
    volumes: [],
  });
  async function ready() {
    const { row } = await storage.start(storageInput());
    await storage.finish(row.id, row.generation, progress(), healthy(), null);
    return (await storage.get("org", clusterId))!;
  }
  it("reuses the same accepted request and refuses a changed disk plan", async () => {
    const first = await storage.start(storageInput());
    const second = await storage.start(storageInput());
    expect(second).toMatchObject({ started: false, row: { id: first.row.id } });
    await expect(
      storage.start({ ...storageInput(), config: { ...storageInput().config, replicas: 3 } }),
    ).rejects.toThrow(/saved configuration/);
    expect(await storage.get("other", clusterId)).toBeNull();
  });
  it("cannot mark setup ready from host checks alone", async () => {
    const { row } = await storage.start(storageInput());
    const partial = progress();
    partial.steps.pop();
    await expect(storage.finish(row.id, 1, partial, healthy(), null)).rejects.toThrow(
      /checks finish/,
    );
    await expect(
      storage.finish(row.id, 1, progress(), { ...healthy(), ready: false }, null),
    ).rejects.toThrow(/checks finish/);
    expect((await storage.get("org", clusterId))?.status).toBe("setting_up");
  });
  it("expires abandoned work and fences the old worker after explicit retry", async () => {
    const { row } = await storage.start(storageInput());
    await db
      .update(schema.clusterStorage)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.clusterStorage.id, row.id));
    const interrupted = (await storage.get("org", clusterId))!;
    expect(interrupted.status).toBe("interrupted");
    const retry = await storage.change("org", clusterId, interrupted.sequence, "retry");
    expect(retry.generation).toBe(row.generation + 1);
    expect(await storage.heartbeat(row.id, row.generation)).toBe(false);
    await expect(storage.progress(row.id, row.generation, progress())).rejects.toThrow(
      /no longer owns/,
    );
    expect(await storage.finish(row.id, row.generation, progress(), healthy(), null)).toBe(false);
  });
  it("protects runtime removal and admits replicated databases only after storage is ready", async () => {
    await expect(
      databases.start({ ...input(), config: { ...config, storageClass: "openship-replicated" } }),
    ).rejects.toThrow(/shared storage/);
    const row = await ready();
    const runtime = await runtimes.get("org", clusterId);
    await expect(runtimes.change("org", clusterId, runtime!.sequence, "remove")).rejects.toThrow(
      /storage/i,
    );
    await databases.start({
      ...input(),
      config: { ...config, storageClass: "openship-replicated" },
    });
    await expect(storage.change("org", clusterId, row.sequence, "remove")).rejects.toThrow(
      /database still uses/,
    );
  });
  it("protects backup destinations until storage has been removed", async () => {
    const destinations = createBackupDestinationRepo(db);
    await destinations.create({
      id: "files-s3",
      organizationId: "org",
      name: "File archives",
      kind: "s3_compatible",
      bucket: "backups",
      accessKeyIdEnc: "key",
      secretAccessKeyEnc: "secret",
    });
    const row = await ready();
    const changed = await storage.configureBackup("org", clusterId, row.sequence, "files-s3");
    await storage.finish(changed.id, changed.generation, progress(), healthy(), null);
    expect(await destinations.softDelete("files-s3")).toMatchObject({ ok: false });
    await expect(destinations.update("files-s3", { bucket: "different" })).rejects.toThrow();
    const current = (await storage.get("org", clusterId))!;
    const removing = await storage.change("org", clusterId, current.sequence, "remove");
    const removed: ClusterStorageProgress = {
      steps: [
        { id: "remove", status: "completed", message: null, startedAt: null, finishedAt: null },
      ],
      logs: [],
    };
    await storage.finish(removing.id, removing.generation, removed, null, null);
    expect(await destinations.softDelete("files-s3")).toEqual({ ok: true });
  });
});
