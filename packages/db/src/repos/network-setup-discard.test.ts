import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import {
  managedOperationFixture,
  managedPreparationFixture,
  successfulManagedReport,
} from "../../../contracts/test/managed-network-fixtures";
import * as schema from "../schema";
import { createServerClusterRepo } from "./server-cluster.repo";
import { createNetworkPreparationRepo } from "./network-preparation.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const preparations = createNetworkPreparationRepo(db);
const clusters = createServerClusterRepo(db);
const draft = managedPreparationFixture();
const planned = managedOperationFixture();
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => client.close());
beforeEach(async () => {
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
  await db.insert(schema.servers).values(
    draft.input.members.map((member) => ({
      id: member.serverId,
      organizationId: "org-a",
      sshHost: member.endpoint!,
    })),
  );
});
const start = () => preparations.start("org-a", "user", "input", draft.input, draft.hosts);
async function failed() {
  await start();
  const hosts = structuredClone(draft.hosts);
  hosts[0]!.logs.push({
    timestamp: new Date().toISOString(),
    step: "python3",
    level: "error",
    message: "Package repository unavailable",
  });
  await preparations.finish(draft.id, 1, hosts, null, "A tool could not be installed");
  return preparations.get("org-a", draft.id);
}
async function ready(link = true) {
  await start();
  const operation = await clusters.savePlan(
    "org-a",
    draft.id,
    "user",
    "input",
    planned.planHash,
    {
      ...planned.plan,
      preparationId: draft.id,
    },
    1,
  );
  const hosts = draft.hosts.map((host) => ({
    ...host,
    hostIdentity: `host:${host.serverId}`,
    steps: host.steps.map((step) => ({ ...step, status: "completed" as const })),
  }));
  await preparations.finish(
    draft.id,
    1,
    hosts,
    link ? operation.id : null,
    link ? null : "Controller stopped after saving the plan",
  );
  return { preparation: await preparations.get("org-a", draft.id), operation };
}

describe("discarding managed network setup", () => {
  it("removes failed setup from pending work, retains diagnostics and rejects delayed retries", async () => {
    const before = await failed();
    const result = await preparations.discard("org-a", draft.id, before.sequence);
    expect(result.preparation).toMatchObject({
      status: "cancelled",
      sequence: before.sequence + 1,
      generation: 2,
      leaseExpiresAt: null,
    });
    expect(result.preparation!.hosts[0]!.logs).toEqual(before.hosts[0]!.logs);
    expect(await preparations.list("org-a")).toEqual([]);
    const replay = await preparations.discard("org-a", draft.id, before.sequence);
    expect(replay.preparation!.sequence).toBe(result.preparation!.sequence);
    await expect(start()).rejects.toThrow("discarded");
    expect(await preparations.heartbeat(draft.id, 1)).toBe(false);
    await expect(
      preparations.finish(draft.id, 1, draft.hosts, null, "late failure"),
    ).rejects.toThrow("no longer owns");
    expect(await db.select().from(schema.servers)).toHaveLength(2);
  });

  it("rejects running, stale and cross-organization discard requests", async () => {
    await start();
    await expect(preparations.discard("org-a", draft.id, 1)).rejects.toThrow("still running");
    await preparations.finish(draft.id, 1, draft.hosts, null, "Failed");
    await expect(preparations.discard("org-a", draft.id, 1)).rejects.toThrow("changed");
    await expect(preparations.discard("org-b", draft.id, 2)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await preparations.get("org-a", draft.id)).status).toBe("failed");
    expect(await preparations.list("org-a")).toHaveLength(1);
  });

  it("discards a preparation and its saved plan atomically, including a crash before their link was written", async () => {
    const { preparation, operation } = await ready(false);
    expect(preparation.operationId).toBeNull();
    await preparations.discard("org-a", draft.id, preparation.sequence);
    expect(await preparations.get("org-a", draft.id)).toMatchObject({
      status: "cancelled",
      operationId: operation.id,
    });
    expect(await clusters.getOperation("org-a", operation.id)).toMatchObject({
      status: "cancelled",
      sequence: 2,
    });
    expect(
      await clusters.claimOperation("org-a", operation.id, operation.planHash, "apply"),
    ).toMatchObject({ started: false, operation: { status: "cancelled" } });
    expect(await clusters.list("org-a")).toEqual([]);
    expect(await clusters.membership("server-a")).toBeNull();
  });

  it("discards from the plan page with the same ownership, hash and idempotency guards", async () => {
    const { operation } = await ready();
    await expect(
      clusters.discardPlan("org-b", operation.id, operation.planHash),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(clusters.discardPlan("org-a", operation.id, "changed")).rejects.toThrow(
      "reviewed plan",
    );
    expect((await preparations.get("org-a", draft.id)).status).toBe("ready");
    const result = await clusters.discardPlan("org-a", operation.id, operation.planHash);
    expect(result.preparation!.status).toBe("cancelled");
    expect(result.operation!.status).toBe("cancelled");
    expect(await preparations.list("org-a")).toEqual([]);
    expect(
      (await clusters.discardPlan("org-a", operation.id, operation.planHash)).operation!.sequence,
    ).toBe(result.operation!.sequence);
  });

  it("serializes discard against apply without losing an active cluster or its reservations", async () => {
    const { operation } = await ready();
    const results = await Promise.allSettled([
      clusters.discardPlan("org-a", operation.id, operation.planHash),
      clusters.claimOperation("org-a", operation.id, operation.planHash, "apply"),
    ]);
    const saved = await clusters.getOperation("org-a", operation.id);
    if (saved.status === "cancelled") {
      expect(results[0]!.status).toBe("fulfilled");
      expect(await clusters.list("org-a")).toEqual([]);
      expect(await clusters.membership("server-a")).toBeNull();
      expect((await preparations.get("org-a", draft.id)).status).toBe("cancelled");
    } else {
      expect(saved.status).toBe("applying");
      expect(results[0]!.status).toBe("rejected");
      expect(await clusters.list("org-a")).toHaveLength(1);
      expect(await clusters.membership("server-a")).not.toBeNull();
      expect((await preparations.get("org-a", draft.id)).status).toBe("ready");
    }
    expect(results[1]!.status).toBe("fulfilled");
  });

  it("keeps incomplete network cleanup visible and reserved until every server acknowledges rollback", async () => {
    const { preparation, operation } = await ready();
    const claimed = await clusters.claimOperation(
      "org-a",
      operation.id,
      operation.planHash,
      "apply",
    );
    await clusters.progressOperation(
      operation.id,
      claimed.operation.generation,
      "needs_attention",
      operation.hosts,
      null,
      "One server is unreachable",
    );
    await expect(preparations.discard("org-a", draft.id, preparation.sequence)).rejects.toThrow(
      "Network changes have already started",
    );
    await expect(clusters.discardPlan("org-a", operation.id, operation.planHash)).rejects.toThrow(
      "Network changes have already started",
    );
    expect(await clusters.membership("server-a")).not.toBeNull();
    const recovery = await clusters.claimOperation(
      "org-a",
      operation.id,
      operation.planHash,
      "rollback",
    );
    const restored = operation.hosts.map((host) => ({ ...host, stage: "rolled_back" as const }));
    await expect(
      clusters.finishOperation(
        "org-a",
        operation.id,
        recovery.operation.generation,
        "rolled_back",
        restored.slice(1),
        null,
        null,
      ),
    ).rejects.toThrow("Every server must acknowledge");
    expect(await clusters.list("org-a")).toHaveLength(1);
    expect(await clusters.membership("server-a")).not.toBeNull();
    await clusters.finishOperation(
      "org-a",
      operation.id,
      recovery.operation.generation,
      "rolled_back",
      restored,
      null,
      null,
    );
    expect(await clusters.list("org-a")).toEqual([]);
    expect(await clusters.membership("server-a")).toBeNull();
    await preparations.discard("org-a", draft.id, preparation.sequence);
    expect((await clusters.getOperation("org-a", operation.id)).status).toBe("rolled_back");
    expect(await db.select().from(schema.servers)).toHaveLength(2);
  });

  it("fences late plan publication after retry or discard", async () => {
    await failed();
    await start();
    const plan = { ...planned.plan, preparationId: draft.id };
    await expect(
      clusters.savePlan("org-a", draft.id, "user", "input", planned.planHash, plan, 1),
    ).rejects.toThrow("no longer owns");
    expect(await clusters.findOperation("org-a", draft.id)).toBeNull();
    await preparations.finish(draft.id, 2, draft.hosts, null, "Failed again");
    const latest = await preparations.get("org-a", draft.id);
    await preparations.discard("org-a", draft.id, latest.sequence);
    await expect(
      clusters.savePlan("org-a", draft.id, "user", "input", planned.planHash, plan, 2),
    ).rejects.toThrow("discarded");
    await expect(
      clusters.savePlan("org-a", draft.id, "user", "input", planned.planHash, planned.plan),
    ).rejects.toThrow("discarded");
    expect(await clusters.findOperation("org-a", draft.id)).toBeNull();
  });

  it("discarding a removal plan preserves the established cluster and network", async () => {
    const { operation } = await ready();
    const claimed = await clusters.claimOperation(
      "org-a",
      operation.id,
      operation.planHash,
      "apply",
    );
    const hosts = operation.hosts.map((host, index) => ({
      ...host,
      stage: "committed" as const,
      publicKey: Buffer.alloc(32, index + 1).toString("base64"),
    }));
    await clusters.finishOperation(
      "org-a",
      operation.id,
      claimed.operation.generation,
      "succeeded",
      hosts,
      successfulManagedReport(operation.plan),
      null,
    );
    const before = await clusters.get("org-a", operation.clusterId);
    const removal = await clusters.savePlan(
      "org-a",
      "remove-plan",
      "user",
      "remove",
      planned.planHash,
      {
        ...planned.plan,
        baseRevision: before.revision,
        intent: "remove",
        previous: planned.plan.config,
      },
    );
    await clusters.discardPlan("org-a", removal.id, removal.planHash);
    const after = await clusters.get("org-a", operation.clusterId);
    expect(after.members).toEqual(before.members);
    expect(after.network).toEqual(before.network);
    expect(after.revision).toBe(before.revision);
    expect(await db.select().from(schema.servers)).toHaveLength(2);
  });
});
