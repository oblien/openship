import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  initialManagedNetworkInput,
  managedNetworkSteps,
  MANAGED_NETWORK_PREPARATION_STEPS,
} from "@repo/core";
import { managedOperationFixture } from "../../../contracts/test/managed-network-fixtures";
import * as schema from "../schema";
import { createServerClusterRepo } from "./server-cluster.repo";
import { createNetworkPreparationRepo } from "./network-preparation.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const preparations = createNetworkPreparationRepo(db);
const clusters = createServerClusterRepo(db);
const planned = managedOperationFixture(["server-a", "server-b", "server-c"]);
const input = initialManagedNetworkInput(planned.plan, planned.id);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hosts = planned.plan.hosts.map((host) => ({
  serverId: host.serverId,
  name: host.name,
  address: host.endpoint,
  hostIdentity: host.hostIdentity,
  steps: managedNetworkSteps(MANAGED_NETWORK_PREPARATION_STEPS).map((step) => ({
    ...step,
    status: "completed" as const,
  })),
  logs: [
    {
      timestamp: new Date().toISOString(),
      step: "python3" as const,
      level: "info" as const,
      message: "Already installed",
    },
  ],
}));
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => client.close());
beforeEach(async () => {
  // Reset the isolated fixture, including unresolved operations from the prior
  // test. Production organization deletion correctly refuses that state.
  await client.exec('TRUNCATE TABLE "organization" CASCADE');
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
  await db
    .insert(schema.servers)
    .values(
      hosts.map((host) => ({ id: host.serverId, organizationId: "org-a", sshHost: host.address })),
    );
});
const start = () => preparations.start("org-a", "user", hash(input), input, hosts);
async function failed() {
  await start();
  await preparations.finish(input.requestId, 1, hosts, null, "One server failed");
  return preparations.get("org-a", input.requestId);
}
async function ready(link = true) {
  await start();
  const operation = await clusters.savePlan(
    "org-a",
    planned.id,
    "user",
    hash(input),
    planned.planHash,
    { ...planned.plan, preparationId: input.requestId },
    1,
  );
  await preparations.finish(
    input.requestId,
    1,
    hosts,
    link ? operation.id : null,
    link ? null : "Controller stopped",
  );
  return operation;
}
async function partial() {
  const operation = await ready();
  const claimed = await clusters.claimOperation("org-a", operation.id, operation.planHash, "apply");
  await clusters.progressOperation(
    operation.id,
    claimed.operation.generation,
    "needs_attention",
    operation.hosts,
    null,
    "Server C unreachable",
  );
  return clusters.getOperation("org-a", operation.id);
}
const prepTarget = (sequence: number, requestId = randomUUID()) => ({
  preparationId: input.requestId,
  sequence,
  serverId: "server-c",
  requestId,
});
const opTarget = (operation: typeof planned, requestId = randomUUID()) => ({
  operationId: operation.id,
  sequence: operation.sequence,
  planHash: operation.planHash,
  serverId: "server-c",
  requestId,
});

describe("revising managed network connections", () => {
  const access = {
    version: 1 as const,
    rules: [
      { sourceServerId: "server-a", targetServerId: "server-b" },
      { sourceServerId: "server-a", targetServerId: "server-c" },
    ],
  };
  const target = (sequence: number) => ({
    preparationId: input.requestId,
    sequence,
    requestId: randomUUID(),
    access,
  });

  it("replaces a failed preparation without removing servers or rewriting its history", async () => {
    const before = await failed();
    const change = target(before.sequence);
    const result = await preparations.reviseAccess("org-a", "user", change);
    expect(result.preparation).toMatchObject({
      id: change.requestId,
      status: "pending",
      cleanupOperationId: null,
      input: { access },
    });
    expect(result.preparation.input.members).toEqual(before.input.members);
    expect(result.preparation.hosts).toEqual(before.hosts);
    expect(result.sourcePreparation).toMatchObject({
      status: "cancelled",
      replacementPreparationId: change.requestId,
      input: before.input,
      inputHash: before.inputHash,
    });
    expect(await db.select().from(schema.servers)).toHaveLength(3);
    expect(await preparations.heartbeat(before.id, before.generation)).toBe(false);
    const replay = await preparations.reviseAccess("org-a", "user", change);
    expect(replay.preparation).toEqual(result.preparation);
    expect(replay.sourcePreparation!.sequence).toBe(result.sourcePreparation!.sequence);
    await expect(
      preparations.reviseAccess("org-a", "user", { ...change, access: { version: 1, rules: [] } }),
    ).rejects.toThrow("different setup changes");
  });

  it("invalidates the prior approval atomically and keeps the allocated range in the revised input", async () => {
    const operation = await ready();
    const before = await preparations.get("org-a", input.requestId);
    const result = await preparations.reviseAccess("org-a", "user", target(before.sequence));
    expect(result.operation).toMatchObject({
      status: "cancelled",
      plan: operation.plan,
      planHash: operation.planHash,
      replacementPreparationId: result.preparation.id,
    });
    expect(result.preparation.input).toMatchObject({
      members: before.input.members,
      cidr: operation.plan.config.network.cidrs[0],
      mtu: operation.plan.config.network.mtu,
      probePort: operation.plan.config.network.probePort,
      access,
    });
    await expect(
      clusters.claimOperation("org-a", operation.id, operation.planHash, "apply"),
    ).rejects.toThrow();
    expect((await preparations.list("org-a")).map((value) => value.id)).toEqual([
      result.preparation.id,
    ]);
  });

  it("rejects running, stale, foreign and invalid policy requests without publishing a revision", async () => {
    await start();
    await expect(preparations.reviseAccess("org-a", "user", target(1))).rejects.toThrow(
      "still running",
    );
    await preparations.finish(input.requestId, 1, hosts, null, "Failed");
    const before = await preparations.get("org-a", input.requestId);
    await expect(preparations.reviseAccess("org-a", "user", target(1))).rejects.toThrow(
      "Setup changed",
    );
    await expect(
      preparations.reviseAccess("org-b", "user", target(before.sequence)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      preparations.reviseAccess("org-a", "user", {
        ...target(before.sequence),
        access: { version: 1, rules: [{ sourceServerId: "server-a", targetServerId: "foreign" }] },
      }),
    ).rejects.toThrow("two different servers");
    expect(await db.select().from(schema.managedNetworkPreparation)).toHaveLength(1);
    expect((await preparations.get("org-a", before.id)).status).toBe("failed");
  });

  it("cannot supersede an operation that has already changed hosts", async () => {
    await partial();
    const before = await preparations.get("org-a", input.requestId);
    await expect(
      preparations.reviseAccess("org-a", "user", target(before.sequence)),
    ).rejects.toThrow("Restore the applied network changes");
    expect(await db.select().from(schema.managedNetworkPreparation)).toHaveLength(1);
  });

  it("retains one-way access when a member is subsequently removed", async () => {
    const before = await failed();
    const changed = await preparations.reviseAccess("org-a", "user", target(before.sequence));
    const removed = await preparations.removeMember("org-a", "user", {
      preparationId: changed.preparation.id,
      sequence: changed.preparation.sequence,
      serverId: "server-c",
      requestId: randomUUID(),
    });
    expect(removed.preparation.input.access).toEqual({ version: 1, rules: [access.rules[0]] });
    expect(removed.preparation.input.members.map((value) => value.serverId)).toEqual([
      "server-a",
      "server-b",
    ]);
  });
});

describe("removing one server from initial managed network setup", () => {
  it("atomically replaces failed preparation, retains history and reuses remaining host diagnostics", async () => {
    const source = await failed();
    const servers = await db.select().from(schema.servers);
    const target = prepTarget(source.sequence);
    const result = await preparations.removeMember("org-a", "user", target);
    expect(result.preparation).toMatchObject({
      id: target.requestId,
      status: "pending",
      cleanupOperationId: null,
    });
    expect(result.preparation.input.members.map((member) => member.serverId)).toEqual([
      "server-a",
      "server-b",
    ]);
    expect(result.preparation.hosts).toEqual(hosts.slice(0, 2));
    expect(result.sourcePreparation).toMatchObject({
      status: "cancelled",
      replacementPreparationId: target.requestId,
      sequence: source.sequence + 1,
    });
    expect(result.sourcePreparation!.input).toEqual(source.input);
    expect(result.sourcePreparation!.hosts).toEqual(source.hosts);
    expect(await db.select().from(schema.servers)).toEqual(servers);
    expect(await clusters.list("org-a")).toEqual([]);
    expect(await preparations.list("org-a")).toMatchObject([
      { id: target.requestId, status: "pending", serverCount: 2 },
    ]);
    const next = await preparations.start(
      "org-a",
      "user",
      result.preparation.inputHash,
      result.preparation.input,
      result.preparation.hosts,
    );
    expect(next.started).toBe(true);
    const replay = await preparations.removeMember("org-a", "user", target);
    expect(replay.preparation).toMatchObject({ id: target.requestId, status: "preparing" });
    expect(replay.sourcePreparation!.sequence).toBe(result.sourcePreparation!.sequence);
    await expect(start()).rejects.toThrow("discarded");
    expect(await preparations.heartbeat(input.requestId, 1)).toBe(false);
  });

  it("rejects running, stale and cross-organization changes without creating another request", async () => {
    await start();
    await expect(preparations.removeMember("org-a", "user", prepTarget(1))).rejects.toThrow(
      "still running",
    );
    await preparations.finish(input.requestId, 1, hosts, null, "Failed");
    await expect(preparations.removeMember("org-a", "user", prepTarget(1))).rejects.toThrow(
      "Setup changed",
    );
    await expect(preparations.removeMember("org-b", "user", prepTarget(2))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await db.select().from(schema.managedNetworkPreparation)).toHaveLength(1);
  });

  it("allows another selection change while preparation is paused without starting a worker", async () => {
    await db
      .insert(schema.servers)
      .values({ id: "server-d", organizationId: "org-a", sshHost: "192.0.2.4" });
    const largerInput = {
      ...input,
      members: [
        ...input.members,
        { ...input.members[0]!, serverId: "server-d", endpoint: "192.0.2.4" },
      ],
    };
    const largerHosts = [
      ...hosts,
      {
        ...hosts[0]!,
        serverId: "server-d",
        name: "D",
        address: "192.0.2.4",
        hostIdentity: "host:server-d",
      },
    ];
    await preparations.start("org-a", "user", hash(largerInput), largerInput, largerHosts);
    await preparations.finish(input.requestId, 1, largerHosts, null, "A server failed");
    const original = await preparations.get("org-a", input.requestId);
    const first = await preparations.removeMember("org-a", "user", prepTarget(original.sequence));
    const second = await preparations.removeMember("org-a", "user", {
      preparationId: first.preparation.id,
      sequence: first.preparation.sequence,
      serverId: "server-d",
      requestId: randomUUID(),
    });
    expect(second.preparation).toMatchObject({
      status: "pending",
      leaseExpiresAt: null,
      cleanupOperationId: null,
    });
    expect(second.preparation.input.members.map((member) => member.serverId)).toEqual([
      "server-a",
      "server-b",
    ]);
    expect((await preparations.get("org-a", first.preparation.id)).status).toBe("cancelled");
    expect(await clusters.list("org-a")).toEqual([]);
    expect(
      (
        await preparations.start(
          "org-a",
          "user",
          second.preparation.inputHash,
          second.preparation.input,
          second.preparation.hosts,
        )
      ).started,
    ).toBe(true);
  });

  it("binds retries to the removed server and rejects divergent simultaneous selections", async () => {
    const source = await failed();
    const target = prepTarget(source.sequence);
    const results = await Promise.all([
      preparations.removeMember("org-a", "user", target),
      preparations.removeMember("org-a", "user", target),
    ]);
    expect(results[0].preparation.id).toBe(results[1].preparation.id);
    await expect(
      preparations.removeMember("org-a", "user", { ...target, serverId: "server-b" }),
    ).rejects.toThrow("different server");
    await expect(
      preparations.removeMember("org-a", "user", { ...target, requestId: randomUUID() }),
    ).rejects.toThrow("already changed");
    expect(await db.select().from(schema.managedNetworkPreparation)).toHaveLength(2);
  });

  it("keeps the original setup intact if the replacement request belongs to another setup", async () => {
    const source = await failed();
    const other = { ...input, requestId: randomUUID() };
    await preparations.start("org-a", "user", hash(other), other, hosts);
    await expect(
      preparations.removeMember("org-a", "user", prepTarget(source.sequence, other.requestId)),
    ).rejects.toThrow("another setup");
    expect(await preparations.get("org-a", source.id)).toMatchObject({
      status: "failed",
      replacementPreparationId: null,
      sequence: source.sequence,
    });
  });

  it("cancels a saved but unlinked plan and fences late publication", async () => {
    const operation = await ready(false);
    const source = await preparations.get("org-a", input.requestId);
    const result = await preparations.removeMember("org-a", "user", prepTarget(source.sequence));
    expect(result.operation).toMatchObject({
      id: operation.id,
      status: "cancelled",
      replacementPreparationId: result.preparation.id,
    });
    await expect(
      clusters.claimOperation("org-a", operation.id, operation.planHash, "apply"),
    ).rejects.toThrow("selection has changed");
    await expect(
      clusters.savePlan(
        "org-a",
        operation.id,
        "user",
        hash(input),
        operation.planHash,
        operation.plan,
        1,
      ),
    ).rejects.toThrow("discarded");
    expect(result.preparation.cleanupOperationId).toBeNull();
    expect(result.preparation.input.cidr).toBe(planned.plan.config.network.cidrs[0]);
    expect(await clusters.membership("server-c")).toBeNull();
  });

  it("retains all host reservations until rollback completes, then allows preparation with the remaining hosts", async () => {
    const operation = await partial();
    const servers = await db.select().from(schema.servers);
    const target = opTarget({
      ...planned,
      ...operation,
      leaseExpiresAt: null,
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
    });
    const result = await preparations.removeMember("org-a", "user", target);
    const child = result.preparation;
    expect(child.cleanupOperationId).toBe(operation.id);
    expect(child.input.clusterId).toBeUndefined();
    expect(result.operation!.plan).toEqual(operation.plan);
    expect(result.operation!.hosts).toEqual(operation.hosts);
    expect(await db.select().from(schema.managedNetworkClaim)).toHaveLength(3);
    await expect(
      preparations.start("org-a", "user", child.inputHash, child.input, child.hosts),
    ).rejects.toThrow("every server");
    await expect(preparations.discard("org-a", child.id, child.sequence)).rejects.toThrow(
      "previous network",
    );
    await expect(
      clusters.claimOperation("org-a", operation.id, operation.planHash, "resume"),
    ).rejects.toThrow("selection has changed");
    const cleanup = await clusters.claimOperation(
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
        cleanup.operation.generation,
        "rolled_back",
        restored.slice(0, 2),
        null,
        null,
      ),
    ).rejects.toThrow("Every server must acknowledge");
    expect(await db.select().from(schema.managedNetworkClaim)).toHaveLength(3);
    await clusters.finishOperation(
      "org-a",
      operation.id,
      cleanup.operation.generation,
      "rolled_back",
      restored,
      null,
      null,
    );
    expect(await clusters.list("org-a")).toEqual([]);
    expect(await db.select().from(schema.managedNetworkClaim)).toHaveLength(0);
    const next = await preparations.start(
      "org-a",
      "user",
      child.inputHash,
      child.input,
      child.hosts,
    );
    expect(next).toMatchObject({ started: true, preparation: { status: "preparing" } });
    expect(next.preparation.hosts.map((host) => host.serverId)).toEqual(["server-a", "server-b"]);
    expect(await db.select().from(schema.servers)).toEqual(servers);
    expect(await clusters.findOperation("org-a", child.id)).toBeNull(); // Must review before applying.
  });

  it("keeps pending continuation after an unreachable host and permits the existing cleanup retry", async () => {
    const operation = await partial();
    const result = await preparations.removeMember("org-a", "user", {
      operationId: operation.id,
      planHash: operation.planHash,
      sequence: operation.sequence,
      serverId: "server-c",
      requestId: randomUUID(),
    });
    const cleanup = await clusters.claimOperation(
      "org-a",
      operation.id,
      operation.planHash,
      "rollback",
    );
    await clusters.progressOperation(
      operation.id,
      cleanup.operation.generation,
      "needs_attention",
      operation.hosts,
      null,
      "Server C still unreachable",
    );
    expect(await preparations.get("org-a", result.preparation.id)).toMatchObject({
      status: "pending",
      cleanupOperationId: operation.id,
    });
    expect(await clusters.membership("server-c")).not.toBeNull();
    const retry = await clusters.claimOperation(
      "org-a",
      operation.id,
      operation.planHash,
      "rollback",
    );
    expect(retry).toMatchObject({
      started: true,
      operation: { status: "rolling_back", generation: cleanup.operation.generation + 1 },
    });
  });

  it("rejects a removal below two remaining servers and established cluster edits", async () => {
    const source = await failed();
    await expect(
      preparations.removeMember("org-a", "user", {
        ...prepTarget(source.sequence),
        serverId: "unknown",
      }),
    ).rejects.toThrow("not selected");
    const result = await preparations.removeMember("org-a", "user", prepTarget(source.sequence));
    const child = result.preparation;
    const started = await preparations.start(
      "org-a",
      "user",
      child.inputHash,
      child.input,
      child.hosts,
    );
    await preparations.finish(
      child.id,
      started.preparation.generation,
      child.hosts,
      null,
      "Failed",
    );
    const saved = await preparations.get("org-a", child.id);
    await expect(
      preparations.removeMember("org-a", "user", {
        preparationId: child.id,
        sequence: saved.sequence,
        serverId: "server-a",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("at least two");
    const editInput = { ...input, requestId: randomUUID(), clusterId: "existing", revision: 2 };
    await preparations.start("org-a", "user", hash(editInput), editInput, hosts);
    await preparations.finish(editInput.requestId, 1, hosts, null, "Failed");
    await expect(
      preparations.removeMember("org-a", "user", {
        preparationId: editInput.requestId,
        sequence: 2,
        serverId: "server-c",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("new network");
  });

  it("supports older failed operations without preparation records and checks reviewed hashes", async () => {
    const operation = await clusters.savePlan(
      "org-a",
      planned.id,
      "user",
      hash(input),
      planned.planHash,
      planned.plan,
    );
    await db
      .update(schema.managedNetworkOperation)
      .set({ status: "rolled_back" })
      .where(eq(schema.managedNetworkOperation.id, operation.id));
    await expect(
      preparations.removeMember("org-a", "user", {
        ...opTarget(planned),
        planHash: "a".repeat(64),
      }),
    ).rejects.toThrow("reviewed plan");
    const result = await preparations.removeMember("org-a", "user", opTarget(planned));
    expect(result.sourcePreparation).toBeNull();
    expect(result.preparation.hosts.map((host) => host.hostIdentity)).toEqual(
      hosts.slice(0, 2).map((host) => host.hostIdentity),
    );
    expect(
      (
        await preparations.start(
          "org-a",
          "user",
          result.preparation.inputHash,
          result.preparation.input,
          result.preparation.hosts,
        )
      ).started,
    ).toBe(true);
  });

  it("records a failed continuation without overwriting a worker that already resumed", async () => {
    const source = await failed();
    const { preparation } = await preparations.removeMember(
      "org-a",
      "user",
      prepTarget(source.sequence),
    );
    await preparations.interruptPending("org-b", preparation.id, "Wrong organization");
    expect((await preparations.get("org-a", preparation.id)).status).toBe("pending");
    await preparations.interruptPending("org-a", preparation.id, "Access changed");
    expect(await preparations.get("org-a", preparation.id)).toMatchObject({
      status: "interrupted",
      error: "Access changed",
      sequence: 2,
    });
    await preparations.start(
      "org-a",
      "user",
      preparation.inputHash,
      preparation.input,
      preparation.hosts,
    );
    await preparations.interruptPending("org-a", preparation.id, "Delayed failure");
    expect(await preparations.get("org-a", preparation.id)).toMatchObject({
      status: "preparing",
      error: null,
    });
  });
});
