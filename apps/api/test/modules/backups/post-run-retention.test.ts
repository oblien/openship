import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, db, eq, repos, schema } from "@repo/db";
import {
  seedBackupDestination,
  seedBackupPolicy,
  seedBackupRun,
  seedOrg,
  seedProject,
  seedService,
} from "../../helpers/seed";

const storage = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  deleted: [] as string[],
  refuseDelete: false,
  emptyCapture: false,
  onManifest: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  resolveDestination: () => ({
    preflight: async () => ({ ok: true }),
    put: async (key: string, body: AsyncIterable<Buffer>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      storage.objects.set(key, Buffer.concat(chunks));
      if (key.endsWith("manifest.json")) await storage.onManifest?.();
      return {};
    },
    deleteMany: async (keys: string[]) => {
      if (storage.refuseDelete)
        return { deleted: [], failed: keys.map((key) => ({ key, error: "AccessDenied" })) };
      for (const key of keys) {
        storage.objects.delete(key);
        storage.deleted.push(key);
      }
      return { deleted: keys, failed: [] };
    },
  }),
  resolveProducerForService: () => ({
    kind: "volume",
    async *produce() {
      if (!storage.emptyCapture)
        yield {
          name: "data.tar",
          payloadKind: "volume",
          metadata: {},
          stream: Readable.from([Buffer.from("restorable snapshot")]),
        };
    },
  }),
}));
// Source capture and remote storage are the boundaries. The orchestrator,
// hashes, manifest, database transitions, policy reads and pruning are real.
vi.mock("@repo/platform/engine/modules/backups/source-platform", () => ({
  resolveSourceExecutor: async () => ({ executor: {}, runtime: null }),
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));

import { BackupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { prunePolicy } from "@repo/platform/engine/modules/backups/retention-prune";

beforeEach(() => {
  storage.objects.clear();
  storage.deleted.length = 0;
  storage.refuseDelete = false;
  storage.emptyCapture = false;
  storage.onManifest = undefined;
});
afterEach(() => vi.restoreAllMocks());

async function setup(retainCount = 3) {
  const { organizationId } = await seedOrg();
  const project = await seedProject(organizationId);
  const service = await seedService(project.id, { name: "database", image: "postgres:16" });
  const destination = await seedBackupDestination(organizationId);
  const policy = await seedBackupPolicy(destination.id, {
    projectId: project.id,
    serviceId: service.id,
    retainCount,
    retainDays: null,
  });
  const run = async (serviceId = service.id) => {
    const row = await seedBackupRun(organizationId, {
      projectId: project.id,
      serviceId,
      destinationId: destination.id,
      policyId: policy.id,
      status: "queued",
    });
    await new BackupOrchestrator().execute(row.id);
    return (await repos.backupRun.findById(row.id))!;
  };
  return { policy, service, project, run };
}

describe("post-backup retention (#817)", () => {
  it("keeps the latest three restore points immediately after the fourth successful run", async () => {
    const { run } = await setup();
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await run());
    expect(rows.map((r) => r.status)).toEqual(Array(4).fill("succeeded"));
    expect((await repos.backupRun.findById(rows[0].id))?.deletedAt).toBeInstanceOf(Date);
    expect(storage.deleted).toHaveLength(2); // The expired payload AND its manifest.
    for (const row of rows.slice(1)) {
      expect((await repos.backupRun.findById(row.id))?.deletedAt).toBeNull();
      expect(storage.objects.get(row.manifestKey!)?.length).toBeGreaterThan(0);
    }
    expect(storage.objects.size).toBe(6);
  });

  it("does not prune older restore points after a failed capture", async () => {
    const { run } = await setup(1);
    const first = await run();
    storage.emptyCapture = true;
    expect((await run()).status).toBe("failed");
    expect(storage.deleted).toEqual([]);
    expect(storage.objects.has(first.manifestKey!)).toBe(true);
  });

  it("preserves a successful backup on delete failure and retries cleanup on the next success", async () => {
    const { run } = await setup(1);
    const first = await run();
    storage.refuseDelete = true;
    const second = await run();
    expect(second.status).toBe("succeeded");
    expect(storage.objects.has(second.manifestKey!)).toBe(true);
    expect((await repos.backupRun.findById(first.id))?.deletedAt).toBeNull();
    storage.refuseDelete = false;
    const third = await run();
    expect(third.status).toBe("succeeded");
    expect(storage.objects.size).toBe(2);
    expect(storage.objects.has(third.manifestKey!)).toBe(true);
  });

  it("honors policy changes made while the backup was being captured", async () => {
    const { policy, run } = await setup(1);
    await run();
    storage.onManifest = async () => {
      await db
        .update(schema.backupPolicy)
        .set({ enabled: false })
        .where(eq(schema.backupPolicy.id, policy.id));
    };
    expect((await run()).status).toBe("succeeded");
    expect(storage.deleted).toEqual([]);
  });

  it("does not reclaim the successful run's files when retention throws", async () => {
    const { run } = await setup(1);
    await run();
    vi.spyOn(repos.backupRun, "listByOrganization").mockRejectedValueOnce(
      new Error("retention database unavailable"),
    );
    const successful = await run();
    expect(successful.status).toBe("succeeded");
    expect(storage.objects.has(successful.manifestKey!)).toBe(true);
    expect(storage.deleted).toEqual([]);
    expect(storage.objects.size).toBe(4);
  });

  it("does not prune when a terminal cancellation wins over this worker's success", async () => {
    const { policy, run } = await setup(3);
    for (let i = 0; i < 3; i++) await run();
    await db
      .update(schema.backupPolicy)
      .set({ retainCount: 1 })
      .where(eq(schema.backupPolicy.id, policy.id));
    storage.onManifest = async () => {
      await db
        .update(schema.backupRun)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(
          and(eq(schema.backupRun.policyId, policy.id), eq(schema.backupRun.status, "verifying")),
        );
    };
    expect((await run()).status).toBe("cancelled");
    expect(storage.deleted).toEqual([]);
  });

  it("keeps protected copies and applies retention independently to fan-out services", async () => {
    const { policy, project, run } = await setup(1);
    await repos.backupPolicy.update(policy.id, { serviceId: null });
    const other = await seedService(project.id, { name: "other-database", image: "postgres:16" });
    const protectedRun = await run();
    await db
      .update(schema.backupRun)
      .set({ retentionLockedUntil: new Date(Date.now() + 86_400_000) })
      .where(eq(schema.backupRun.id, protectedRun.id));
    await run(other.id);
    await run();
    await run(other.id);
    expect(storage.objects.size).toBe(6); // Protected copy + newest for each service.
    expect(storage.objects.has(protectedRun.manifestKey!)).toBe(true);
  });

  it("serializes simultaneous policy sweeps so an expired object is deleted once", async () => {
    const { policy, run } = await setup(3);
    for (let i = 0; i < 3; i++) await run();
    await db
      .update(schema.backupPolicy)
      .set({ retainCount: 1 })
      .where(eq(schema.backupPolicy.id, policy.id));
    const outcomes = await Promise.all([prunePolicy(policy), prunePolicy(policy)]);
    expect(outcomes.map((o) => o.dropped)).toEqual([2, 0]);
    expect(new Set(storage.deleted).size).toBe(storage.deleted.length);
    expect(storage.objects.size).toBe(2);
  });
});
