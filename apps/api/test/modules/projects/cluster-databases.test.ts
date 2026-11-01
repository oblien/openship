import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema, repos, seedOwner, type SeededOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import * as lifecycle from "@repo/platform/engine/modules/system/network-setup-lifecycle";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { seedClusterProject } from "../../helpers/cluster-project";
import type { ClusterDatabaseObservation } from "@repo/core";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);
const verified: ClusterDatabaseObservation = {
  ready: true,
  message: "Adapter verification fixture",
  observedAt: new Date().toISOString(),
  primary: "database-1",
  pods: [],
  volumes: [],
};
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "database-test",
      }),
    },
  });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  return { native: native.projects, remote: remote.projects };
}

afterEach(() => vi.restoreAllMocks());

describe("project databases through real HTTP and native operations", () => {
  it("preserves ordinary Swarm database placement without advertising it as managed replication", async () => {
    const owner = await seedOwner();
    const target = await seedClusterProject(owner);
    await db
      .update(schema.clusterRuntime)
      .set({ provider: "swarm" })
      .where(eq(schema.clusterRuntime.id, target.runtime.id));
    await db
      .update(schema.project)
      .set({
        framework: "postgres",
        releaseSource: { mode: "url", artifactKind: "image", imageTemplate: "postgres:17" },
      })
      .where(eq(schema.project.id, target.id));
    const project = (await repos.project.findById(target.id))!;
    const { native } = await clients(owner);
    const result = await native.setClusterTarget(target.id, {
      clusterId: target.clusterId,
      config: { replicas: 1 },
      expectedUpdatedAt: project.updatedAt.toISOString(),
      acknowledgePlacement: true,
    });
    expect(result).toMatchObject({ clusterId: target.clusterId, config: { replicas: 1 } });
    expect(result.unavailableReason).toContain("Database replication");
    expect(await repos.clusterDatabase.list(owner.orgId, target.id)).toEqual([]);
  });
  it("rejects operator databases on Swarm before saving or scheduling an operation", async () => {
    const worker = vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner();
    const target = await seedClusterProject(owner);
    await db
      .update(schema.clusterRuntime)
      .set({ provider: "swarm" })
      .where(eq(schema.clusterRuntime.id, target.runtime.id));
    const { native, remote } = await clients(owner);
    for (const api of [native, remote]) {
      await expect(
        api.createClusterDatabase(target.id, {
          requestId: crypto.randomUUID(),
          name: "postgres",
          config: {
            engine: "postgres",
            mode: "standalone",
            instances: 1,
            storageClass: "openship-local",
            storageGiB: 5,
            cpuMillis: 250,
            memoryMiB: 256,
            databaseName: "app",
          },
        }),
      ).rejects.toMatchObject({ code: "CLUSTER_PROVIDER_UNSUPPORTED" });
    }
    expect(await repos.clusterDatabase.list(owner.orgId, target.id)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
  it("scales PostgreSQL in place and atomically binds separate write and reader endpoints", async () => {
    vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner(),
      target = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    const original = await native.createClusterDatabase(target.id, {
      requestId: crypto.randomUUID(),
      name: "postgres-readers",
      config: {
        engine: "postgres",
        version: "18",
        mode: "standalone",
        instances: 1,
        storageClass: "openship-local",
        storageGiB: 5,
        cpuMillis: 250,
        memoryMiB: 256,
        databaseName: "app",
      },
    });
    await repos.clusterDatabase.finish(original.id, original.generation, "ready", verified, null);
    let current = await remote.getClusterDatabase(target.id, { databaseId: original.id });
    const before = await repos.clusterDatabase.get(owner.orgId, target.id, original.id);
    await expect(
      remote.connectClusterDatabase(target.id, {
        databaseId: current.id,
        expectedSequence: current.sequence,
        envKey: "DATABASE_URL",
        readEnvKey: "DATABASE_READ_URL",
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_READERS_REQUIRED" });
    expect(await repos.project.getEnvMap(target.id, "production")).toEqual({});
    current = await remote.updateClusterDatabase(target.id, {
      databaseId: current.id,
      expectedSequence: current.sequence,
      config: { ...current.config, mode: "cluster", instances: 2 },
    });
    await expect(
      native.updateClusterDatabase(target.id, {
        databaseId: original.id,
        expectedSequence: before.sequence,
        config: { ...current.config, instances: 3 },
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    await repos.clusterDatabase.finish(current.id, current.generation, "ready", verified, null);
    current = await native.getClusterDatabase(target.id, { databaseId: current.id });
    await expect(
      remote.connectClusterDatabase(target.id, {
        databaseId: current.id,
        expectedSequence: current.sequence,
        envKey: "DATABASE_URL",
        readEnvKey: "DATABASE_URL",
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    expect(await repos.project.getEnvMap(target.id, "production")).toEqual({});
    current = await remote.connectClusterDatabase(target.id, {
      databaseId: current.id,
      expectedSequence: current.sequence,
      envKey: "DATABASE_URL",
      readEnvKey: "DATABASE_READ_URL",
    });
    expect(current).toMatchObject({ envKey: "DATABASE_URL", readEnvKey: "DATABASE_READ_URL" });
    const env = await repos.project.getEnvMap(target.id, "production");
    expect(env.DATABASE_URL).not.toContain("postgresql://");
    expect(decrypt(env.DATABASE_URL)).toContain("@database-rw.");
    expect(decrypt(env.DATABASE_READ_URL)).toContain("@database-ro.");
    expect(JSON.stringify(current)).not.toMatch(/readEnvValueEncrypted|secretEncrypted/);
    await expect(
      native.updateClusterDatabase(target.id, {
        databaseId: current.id,
        expectedSequence: current.sequence,
        config: { ...current.config, mode: "standalone", instances: 1 },
      }),
    ).rejects.toThrow("Disconnect applications using the reader endpoint");
    current = await native.connectClusterDatabase(target.id, {
      databaseId: current.id,
      expectedSequence: current.sequence,
      envKey: "DATABASE_URL",
    });
    expect(current.readEnvKey).toBe("DATABASE_READ_URL");
    current = await remote.connectClusterDatabase(target.id, {
      databaseId: current.id,
      expectedSequence: current.sequence,
      envKey: "DATABASE_URL",
      readEnvKey: null,
    });
    expect(
      (await repos.project.getEnvMap(target.id, "production")).DATABASE_READ_URL,
    ).toBeUndefined();
    current = await native.updateClusterDatabase(target.id, {
      databaseId: current.id,
      expectedSequence: current.sequence,
      config: { ...current.config, mode: "standalone", instances: 1 },
    });
    const after = await repos.clusterDatabase.get(owner.orgId, target.id, original.id);
    expect(after).toMatchObject({
      id: before.id,
      secretEncrypted: before.secretEncrypted,
      runtimeId: before.runtimeId,
      clusterId: before.clusterId,
      requestId: before.requestId,
    });
    expect(current.config).toMatchObject({
      version: "18",
      storageGiB: 5,
      storageClass: "openship-local",
    });
  });

  it("retains unrelated secrets and rolls back both bindings when reader ownership conflicts", async () => {
    vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner(),
      target = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    let database = await native.createClusterDatabase(target.id, {
      requestId: crypto.randomUUID(),
      name: "postgres-ownership",
      config: {
        engine: "postgres",
        mode: "cluster",
        instances: 3,
        storageClass: "openship-local",
        storageGiB: 1,
        cpuMillis: 250,
        memoryMiB: 256,
        databaseName: "app",
      },
    });
    await repos.clusterDatabase.finish(database.id, database.generation, "ready", verified, null);
    database = await native.getClusterDatabase(target.id, { databaseId: database.id });
    const custom = await repos.project.setEnvVar({
      projectId: target.id,
      key: "DATABASE_READ_URL",
      value: "user-managed-secret",
      environment: "production",
      isSecret: true,
    });
    await expect(
      remote.connectClusterDatabase(target.id, {
        databaseId: database.id,
        expectedSequence: database.sequence,
        envKey: "DATABASE_URL",
        readEnvKey: "DATABASE_READ_URL",
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    expect(await repos.project.getEnvMap(target.id, "production")).toEqual({
      DATABASE_READ_URL: "user-managed-secret",
    });
    expect(await remote.getClusterDatabase(target.id, { databaseId: database.id })).toMatchObject({
      sequence: database.sequence,
      envKey: null,
      readEnvKey: null,
    });
    await repos.project.deleteEnvVar(custom.id);
    database = await native.connectClusterDatabase(target.id, {
      databaseId: database.id,
      expectedSequence: database.sequence,
      envKey: "DATABASE_URL",
      readEnvKey: "DATABASE_READ_URL",
    });
    const saved = await repos.project.listEnvVars(target.id, "production", null);
    await repos.project.updateEnvVar(
      saved.find((env) => env.key === "DATABASE_READ_URL")!.id,
      "replacement-user-secret",
    );
    database = await remote.connectClusterDatabase(target.id, {
      databaseId: database.id,
      expectedSequence: database.sequence,
      envKey: null,
      readEnvKey: null,
    });
    expect(database).toMatchObject({ envKey: null, readEnvKey: null });
    expect(await repos.project.getEnvMap(target.id, "production")).toEqual({
      DATABASE_READ_URL: "replacement-user-secret",
    });
  });

  it("prepares an imported database before moving its Docker project and pins its source backup", async () => {
    vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner(),
      target = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    await repos.project.update(target.id, { clusterId: null, clusterConfig: null });
    const destinationId = crypto.randomUUID();
    await repos.backupDestination.create({
      id: destinationId,
      organizationId: owner.orgId,
      name: "Existing backups",
      kind: "s3_compatible",
      bucket: "existing-backups",
      pathPrefix: "project-data",
      accessKeyIdEnc: encryptSecretField("test-access"),
      secretAccessKeyEnc: encryptSecretField("test-secret"),
    });
    const runId = crypto.randomUUID(),
      artifact = {
        name: "pg-dump.dump",
        key: "project/database/backup/pg-dump.dump",
        sizeBytes: 123,
        sha256: "a".repeat(64),
        payloadKind: "pg_dump",
        metadata: { compression: "none", format: "custom" },
      };
    await repos.backupRun.create({
      id: runId,
      organizationId: owner.orgId,
      projectId: target.id,
      destinationId,
      status: "succeeded",
      triggeredBy: "manual",
      finishedAt: new Date(),
      artifacts: [artifact],
    });
    for (const client of [native, remote])
      expect(await client.listClusterDatabaseImports(target.id)).toMatchObject([
        { runId, artifactName: artifact.name, engine: "postgres" },
      ]);
    const input = {
      requestId: crypto.randomUUID(),
      name: "imported",
      clusterId: target.clusterId!,
      importFrom: { runId, artifactName: artifact.name },
      config: {
        engine: "postgres" as const,
        mode: "standalone" as const,
        instances: 1,
        storageClass: "openship-local",
        storageGiB: 1,
        cpuMillis: 250,
        memoryMiB: 256,
        databaseName: "app",
      },
    };
    const created = await remote.createClusterDatabase(target.id, input);
    expect(await native.createClusterDatabase(target.id, input)).toEqual(created);
    expect((await repos.project.findById(target.id))!.clusterId).toBeNull();
    expect(await repos.clusterDatabase.hasActiveImport(runId)).toBe(true);
    await expect(
      remote.createClusterDatabase(target.id, {
        ...input,
        config: { ...input.config, storageGiB: 2 },
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    await expect(
      native.createClusterDatabase(target.id, {
        ...input,
        requestId: crypto.randomUUID(),
        name: "wrong-engine",
        config: { ...input.config, engine: "redis" },
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_IMPORT_SOURCE" });
    const other = await clients(await seedOwner());
    await expect(other.remote.listClusterDatabaseImports(target.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await repos.clusterDatabase.progress(created.id, created.generation, {
      steps: [
        {
          id: "restore",
          status: "completed",
          message: "Imported",
          startedAt: null,
          finishedAt: new Date().toISOString(),
        },
      ],
      logs: [],
    });
    expect(await repos.clusterDatabase.hasActiveImport(runId)).toBe(false);
    // Staging the database must not prevent selecting its matching cluster
    // afterward. Both API admission and the repository enforce this boundary.
    await repos.clusterDatabase.finish(created.id, created.generation, "ready", verified, null);
    // The database already owns real resources even while the app still runs
    // on Docker. Removing the project must not cascade away that ownership.
    for (const client of [native, remote])
      await expect(client.remove(target.id)).rejects.toMatchObject({
        code: "CLUSTER_DATABASES_ATTACHED",
      });
    expect((await repos.project.findById(target.id))!.deletionInProgress).toBe(false);
    expect(await repos.clusterDatabase.get(owner.orgId, target.id, created.id)).toMatchObject({
      status: "ready",
    });
    const before = await remote.getClusterWorkload(target.id);
    expect(
      await remote.setClusterTarget(target.id, {
        clusterId: target.clusterId,
        expectedUpdatedAt: before.updatedAt,
        stateless: true,
        config: { replicas: 2, imageRepository: "ghcr.io/team/api" },
      }),
    ).toMatchObject({ clusterId: target.clusterId });
    expect(JSON.stringify(created)).not.toMatch(
      /test-secret|secretEncrypted|pg-dump.dump|project-data/,
    );
  });

  it("reviews a PostgreSQL upgrade into a separate copy and atomically switches the managed connection", async () => {
    vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner(),
      target = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    const destinationId = crypto.randomUUID();
    await repos.backupDestination.create({
      id: destinationId,
      organizationId: owner.orgId,
      name: "Recovery",
      kind: "s3_compatible",
      bucket: "upgrade-backups",
      accessKeyIdEnc: encryptSecretField("access"),
      secretAccessKeyEnc: encryptSecretField("secret"),
    });
    const config = {
      engine: "postgres" as const,
      mode: "standalone" as const,
      instances: 1,
      storageClass: "openship-local",
      storageGiB: 1,
      cpuMillis: 250,
      memoryMiB: 256,
      databaseName: "app",
      backup: { destinationId, schedule: "manual" as const, retentionDays: 7 },
    };
    let source = await native.createClusterDatabase(target.id, {
      requestId: crypto.randomUUID(),
      name: "original",
      config,
    });
    await repos.clusterDatabase.finish(source.id, source.generation, "ready", verified, null);
    source = await native.getClusterDatabase(target.id, { databaseId: source.id });
    source = await native.connectClusterDatabase(target.id, {
      databaseId: source.id,
      expectedSequence: source.sequence,
      envKey: "DATABASE_URL",
    });
    const input = {
      requestId: crypto.randomUUID(),
      name: "upgraded",
      config: { ...config, version: "18" as const },
      copyFrom: { databaseId: source.id, expectedSequence: source.sequence },
    };
    let copy = await remote.createClusterDatabase(target.id, input);
    expect(copy.sourceDatabaseId).toBe(source.id);
    expect(await native.createClusterDatabase(target.id, input)).toEqual(copy);
    await expect(
      native.removeClusterDatabase(target.id, {
        databaseId: source.id,
        expectedSequence: source.sequence,
        name: source.name,
        deleteData: true,
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    await repos.clusterDatabase.finish(copy.id, copy.generation, "ready", verified, null);
    copy = await native.getClusterDatabase(target.id, { databaseId: copy.id });
    const connection = {
      databaseId: copy.id,
      expectedSequence: copy.sequence,
      envKey: "DATABASE_URL",
    };
    await expect(remote.connectClusterDatabase(target.id, connection)).rejects.toMatchObject({
      code: "CLUSTER_DATABASE_CONFLICT",
    });
    await expect(
      remote.connectClusterDatabase(target.id, {
        ...connection,
        replace: { databaseId: source.id, expectedSequence: source.sequence - 1 },
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    copy = await remote.connectClusterDatabase(target.id, {
      ...connection,
      replace: { databaseId: source.id, expectedSequence: source.sequence },
    });
    expect(copy.envKey).toBe("DATABASE_URL");
    expect(
      (await native.getClusterDatabase(target.id, { databaseId: source.id })).envKey,
    ).toBeNull();
    expect(
      (await repos.clusterDatabase.get(owner.orgId, target.id, copy.id)).restoreSource!.backupId,
    ).toMatch(/^openship\/databases\/os-db-[a-f0-9]+\/postgres\/b-[a-f0-9]+\/manifest.json$/);
  });

  it("shares idempotent setup, progress, connection ownership and retry without leaking credentials", async () => {
    const hostWork = vi
      .spyOn(sshManager, "withExecutor")
      .mockRejectedValue(new Error("Unexpected host work"));
    const dispatch = vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner(),
      target = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    const input = {
      requestId: crypto.randomUUID(),
      name: "postgres",
      config: {
        engine: "postgres" as const,
        mode: "standalone" as const,
        instances: 1,
        storageClass: "openship-local",
        storageGiB: 20,
        cpuMillis: 500,
        memoryMiB: 512,
        databaseName: "app",
      },
    };
    const created = await remote.createClusterDatabase(target.id, input);
    expect(created).toMatchObject({
      status: "provisioning",
      generation: 1,
      clusterId: target.clusterId,
    });
    expect(await native.createClusterDatabase(target.id, input)).toEqual(created);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: "database",
      id: created.id,
      projectId: target.id,
    });
    for (const client of [native, remote]) {
      expect(await client.listClusterDatabases(target.id)).toEqual([created]);
      const controller = new AbortController();
      const events = client
        .streamClusterDatabaseEvents(target.id, { signal: controller.signal })
        [Symbol.asyncIterator]();
      try {
        const event = await events.next();
        const snapshot = JSON.parse(event.value!.data);
        expect(snapshot.run).toEqual([created]);
        expect(event.value!.data).not.toMatch(/secretEncrypted|envValueEncrypted|leaseExpiresAt/);
      } finally {
        controller.abort();
        await events.return?.();
      }
    }
    const other = await clients(await seedOwner());
    for (const client of [other.native, other.remote])
      await expect(
        client.getClusterDatabase(target.id, { databaseId: created.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const observation: ClusterDatabaseObservation = {
      ready: true,
      message: "Verified in the adapter acceptance suite",
      observedAt: new Date().toISOString(),
      primary: "database-1",
      pods: [],
      volumes: [],
    };
    await repos.clusterDatabase.finish(created.id, 1, "ready", observation, null);
    const ready = await remote.getClusterDatabase(target.id, { databaseId: created.id });
    await expect(
      native.connectClusterDatabase(target.id, {
        databaseId: created.id,
        expectedSequence: created.sequence,
        envKey: "DATABASE_URL",
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    const connected = await native.connectClusterDatabase(target.id, {
      databaseId: created.id,
      expectedSequence: ready.sequence,
      envKey: "DATABASE_URL",
    });
    expect(connected.envKey).toBe("DATABASE_URL");
    const variables = await repos.project.getEnvMap(target.id, "production");
    expect(variables.DATABASE_URL).toBeTruthy();
    expect(variables.DATABASE_URL).not.toContain("postgresql://");
    await expect(
      remote.removeClusterDatabase(target.id, {
        databaseId: created.id,
        expectedSequence: connected.sequence,
        name: connected.name,
        deleteData: false,
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    const disconnected = await remote.connectClusterDatabase(target.id, {
      databaseId: created.id,
      expectedSequence: connected.sequence,
      envKey: null,
    });
    expect((await repos.project.getEnvMap(target.id, "production")).DATABASE_URL).toBeUndefined();
    const removing = await remote.removeClusterDatabase(target.id, {
      databaseId: created.id,
      expectedSequence: disconnected.sequence,
      name: created.name,
      deleteData: false,
    });
    await repos.clusterDatabase.finish(
      created.id,
      removing.generation,
      "failed",
      null,
      "Host unavailable",
    );
    const failed = await native.getClusterDatabase(target.id, { databaseId: created.id });
    const retried = await native.retryClusterDatabase(target.id, {
      databaseId: created.id,
      expectedSequence: failed.sequence,
    });
    expect(retried).toMatchObject({
      intent: "remove",
      status: "deleting",
      generation: removing.generation + 1,
    });
    expect(hostWork).not.toHaveBeenCalled();
  });
});
