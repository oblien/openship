import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { NativeClusterConfig } from "@repo/core";
import * as schema from "../schema";
import { createServerClusterRepo } from "./server-cluster.repo";
import { createComputeClusterRepo } from "./compute-cluster.repo";
import {
  managedPlanFixture,
  managedOperationFixture,
  successfulManagedReport,
} from "../../../contracts/test/managed-network-fixtures";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const networks = createServerClusterRepo(db);
const clusters = createComputeClusterRepo(db);
const config = (): NativeClusterConfig => ({
  name: "Private production",
  network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
  members: ["a", "b", "c", "d"].map((serverId, index) => ({
    serverId,
    providerId: "custom",
    privateIp: `10.20.0.${index + 1}`,
  })),
});
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.computeCluster);
  await db.delete(schema.managedNetworkOperation);
  await db.delete(schema.serverCluster);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org", name: "Org" },
    { id: "other", name: "Other" },
  ]);
  await db
    .insert(schema.servers)
    .values(["a", "b", "c", "d"].map((id) => ({ id, organizationId: "org", sshHost: id })));
});

describe("independent networks and compute pools", () => {
  it("creates a network without a cluster and shares it between distinct server pools", async () => {
    const network = await networks.create("org", config(), "network", "hash");
    expect(await clusters.list("org")).toEqual([]);
    const first = await clusters.create(
      "org",
      { name: "Apps", networkId: network.id, serverIds: ["a", "b"] },
      "apps",
      "hash-apps",
    );
    const second = await clusters.create(
      "org",
      { name: "Data", networkId: network.id, serverIds: ["c", "d"] },
      "data",
      "hash-data",
    );
    expect((await clusters.list("org")).map((cluster) => cluster.networkId)).toEqual([
      network.id,
      network.id,
    ]);
    await clusters.remove("org", first.id, first.revision);
    expect((await networks.get("org", network.id)).members).toHaveLength(4);
    expect((await clusters.get("org", second.id)).serverIds).toEqual(["c", "d"]);
    expect(await db.select().from(schema.servers)).toHaveLength(4);
  });
  it("blocks network removal and server detach while a pool depends on them", async () => {
    const network = await networks.create("org", config(), "network", "hash");
    const pool = await clusters.create(
      "org",
      { name: "Apps", networkId: network.id, serverIds: ["a", "b"] },
      "apps",
      "hash-apps",
    );
    await expect(networks.remove("org", network.id, 1)).rejects.toMatchObject({
      code: "NETWORK_IN_USE",
    });
    const changed = config();
    changed.members = changed.members.filter((member) => member.serverId !== "a");
    await expect(networks.update("org", network.id, 1, changed)).rejects.toMatchObject({
      code: "NETWORK_IN_USE",
    });
    await expect(
      db.delete(schema.serverCluster).where(eq(schema.serverCluster.id, network.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.clusterMember).where(eq(schema.clusterMember.serverId, "a")),
    ).rejects.toThrow();
    // Updating unchanged attached membership is legal, despite delete/reinsert inside the transaction.
    const updated = await networks.update("org", network.id, 1, config());
    expect(updated.revision).toBe(2);
    await clusters.update("org", pool.id, 1, {
      name: "Apps",
      networkId: network.id,
      serverIds: ["b"],
    });
    const detached = await networks.update("org", network.id, 2, changed);
    expect(detached.members.map((member) => member.serverId)).toEqual(["b", "c", "d"]);
    await clusters.remove("org", pool.id, 2);
    await networks.remove("org", network.id, 3);
    expect(await networks.list("org")).toEqual([]);
  });
  it("keeps network attachments separate when changing the cluster's communication network", async () => {
    const first = await networks.create("org", config(), "first", "first");
    const value = config();
    value.network.cidrs = ["10.30.0.0/24"];
    value.members = value.members.map((member) => ({
      ...member,
      privateIp: member.privateIp.replace("10.20.", "10.30."),
    }));
    const second = await networks.create("org", value, "second", "second");
    const pool = await clusters.create(
      "org",
      { name: "Apps", networkId: first.id, serverIds: ["a"] },
      "apps",
      "apps",
    );
    expect(await clusters.forServer("org", "a")).toMatchObject({
      networks: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id }),
      ]),
      cluster: { id: pool.id },
    });
    expect(await clusters.forServer("other", "a")).toEqual({ networks: [], cluster: null });
    await clusters.update("org", pool.id, 1, {
      name: "Apps",
      networkId: second.id,
      serverIds: ["a"],
    });
    expect((await networks.get("org", first.id)).members).toHaveLength(4);
    await networks.remove("org", first.id, 1);
    expect((await clusters.get("org", pool.id)).networkId).toBe(second.id);
    expect((await clusters.forServer("org", "a")).networks.map((network) => network.id)).toEqual([
      second.id,
    ]);
  });
  it("enforces scope, membership, optimistic revisions and retry identity", async () => {
    const network = await networks.create("org", config(), "network", "hash");
    const value = { name: "Apps", networkId: network.id, serverIds: ["a"] };
    const [first, retry] = await Promise.all([
      clusters.create("org", value, "same", "hash"),
      clusters.create("org", value, "same", "hash"),
    ]);
    expect(retry.id).toBe(first.id);
    await expect(
      clusters.create("org", { ...value, name: "Other" }, "same", "different"),
    ).rejects.toMatchObject({ code: "CLUSTER_CONFLICT" });
    await expect(clusters.create("org", value, "different", "hash")).rejects.toThrow(
      "another compute cluster",
    );
    await expect(clusters.create("other", value, "foreign", "hash")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(clusters.get("other", first.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(clusters.remove("org", first.id, 5)).rejects.toMatchObject({
      code: "CLUSTER_CONFLICT",
    });
    await expect(
      clusters.create("org", { ...value, serverIds: ["missing"] }, "missing", "hash"),
    ).rejects.toThrow("Connect every selected server");
    expect(await clusters.list("other")).toEqual([]);
  });
  it("keeps an interrupted initial network free to roll back instead of acquiring a cluster dependency", async () => {
    const plan = managedPlanFixture(["a", "b"]);
    const operation = await networks.savePlan(
      "org",
      "managed",
      "user",
      "input",
      managedOperationFixture().planHash,
      plan,
    );
    await networks.claimOperation("org", operation.id, operation.planHash, "apply");
    await expect(
      clusters.create(
        "org",
        { name: "Apps", networkId: plan.clusterId, serverIds: ["a"] },
        "apps",
        "apps",
      ),
    ).rejects.toThrow("Finish network setup");
    expect(await clusters.list("org")).toEqual([]);
  });
  it("rechecks new cluster dependencies when claiming an already-reviewed cleanup", async () => {
    const plan = managedPlanFixture(["a", "b"]);
    const first = await networks.savePlan(
      "org",
      "managed",
      "user",
      "input",
      managedOperationFixture().planHash,
      plan,
    );
    await networks.claimOperation("org", first.id, first.planHash, "apply");
    const hosts = first.hosts.map((host, index) => ({
      ...host,
      stage: "committed" as const,
      publicKey: Buffer.alloc(32, index + 1).toString("base64"),
    }));
    await networks.finishOperation(
      "org",
      first.id,
      1,
      "succeeded",
      hosts,
      successfulManagedReport(plan),
      null,
    );
    const current = await networks.get("org", plan.clusterId);
    const cleanup = await networks.savePlan("org", "cleanup", "user", "remove", "c".repeat(64), {
      ...plan,
      baseRevision: current.revision,
      previous: plan.config,
      intent: "remove",
      hosts: plan.hosts.map((host) => ({ ...host, action: "remove" })),
    });
    const cluster = await clusters.create(
      "org",
      { name: "Apps", networkId: current.id, serverIds: ["a"] },
      "apps",
      "apps",
    );
    await expect(
      networks.claimOperation("org", cleanup.id, cleanup.planHash, "apply"),
    ).rejects.toMatchObject({ code: "NETWORK_IN_USE" });
    expect(await db.select().from(schema.managedNetworkClaim)).toEqual([]);
    expect((await networks.getOperation("org", cleanup.id)).status).toBe("planned");
    await clusters.remove("org", cluster.id, cluster.revision);
    expect(
      await networks.claimOperation("org", cleanup.id, cleanup.planHash, "apply"),
    ).toMatchObject({ started: true });
  });
});
