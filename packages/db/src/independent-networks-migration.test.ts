import { afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";
import { createServerClusterRepo } from "./repos/server-cluster.repo";
import { createComputeClusterRepo } from "./repos/compute-cluster.repo";
import {
  managedOperationFixture,
  managedPreparationFixture,
} from "../../contracts/test/managed-network-fixtures";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));
afterAll(() => client.close());

describe("independent network migration", () => {
  it("preserves existing groups and recovery identities while separating pool membership", async () => {
    const journal = JSON.parse(readFileSync(`${directory}/meta/_journal.json`, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    for (const migration of journal.entries.filter((entry) => entry.idx < 139))
      await client.exec(readFileSync(`${directory}/${migration.tag}.sql`, "utf8"));
    await db.insert(schema.organization).values({ id: "org", name: "Org" });
    for (const id of ["native", "ready", "initial", "recovering"]) {
      const managed = id !== "native";
      await client.query(
        "INSERT INTO server_cluster (id, organization_id, name, revision, request_id, input_hash) VALUES ($1, $2, $1, $3, $1, $4)",
        [id, "org", id === "initial" ? 1 : 3, `hash:${id}`],
      );
      await client.query(
        "INSERT INTO cluster_network (id, cluster_id, mode, cidrs, mtu, probe_port, ownership) VALUES ($1, $2, $3, $4, 1400, 51821, $5)",
        [
          `config:${id}`,
          id,
          managed ? "wireguard" : "native",
          '["10.244.0.0/24"]',
          managed ? "openship" : "external",
        ],
      );
      for (const [index, serverId] of [`${id}-a`, `${id}-b`].entries()) {
        // Seed the historical schema without columns added by later migrations.
        await client.query(
          "INSERT INTO servers (id, organization_id, ssh_host) VALUES ($1, $2, $1)",
          [serverId, "org"],
        );
        await client.query(
          "INSERT INTO cluster_member (id, cluster_id, server_id, host_identity) VALUES ($1, $2, $1, $3)",
          [serverId, id, `host:${serverId}`],
        );
        await db
          .insert(schema.serverNetworkAttachment)
          .values({
            id: serverId,
            networkId: `config:${id}`,
            serverId,
            providerId: "custom",
            privateIp: `10.244.0.${index + 1}`,
          });
      }
    }
    const operation = managedOperationFixture(["initial-a", "initial-b"]);
    operation.plan.clusterId = "initial";
    operation.clusterId = "initial";
    await client.query("UPDATE server_cluster SET request_id = $1 WHERE id = $2", [
      "op:initial",
      "initial",
    ]);
    // A successful first managed setup remains revision 1, just like an unfinished setup.
    await client.query("UPDATE server_cluster SET revision = 1 WHERE id = $1", ["ready"]);
    const preparation = managedPreparationFixture(["initial-a", "initial-b"]);
    preparation.input.clusterId = "initial";
    for (const id of ["initial", "recovering", "ready"]) {
      const plan = { ...operation.plan, clusterId: id };
      await client.query(
        "INSERT INTO managed_network_operation (id, organization_id, cluster_id, input_hash, plan_hash, plan, status, hosts, created_by, generation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2)",
        [
          `op:${id}`,
          "org",
          id,
          "original-input",
          operation.planHash,
          JSON.stringify(plan),
          id === "ready" ? "succeeded" : "interrupted",
          JSON.stringify(operation.hosts),
          "user",
        ],
      );
    }
    await db.insert(schema.managedNetworkPreparation).values({
      id: "preparation",
      organizationId: "org",
      inputHash: "original-input",
      input: preparation.input,
      hosts: preparation.hosts,
      status: "ready",
      operationId: "op:initial",
      createdBy: "user",
    });
    await client.query(
      "INSERT INTO managed_network_claim (server_id, host_identity, organization_id, cluster_id, operation_id) VALUES ($1, $2, $3, $4, $5)",
      ["initial-a", "host:initial-a", "org", "initial", "op:initial"],
    );
    await client.query(
      "INSERT INTO cluster_verification (id, cluster_id, revision, status, report, created_by, expires_at) VALUES ($1, $2, 3, $3, $4, $5, now())",
      ["verification", "native", "success", '{"hosts":[],"peers":[],"stage":"complete"}', "user"],
    );

    // Exercise the upgrade through the current schema before using current repos.
    for (const migration of journal.entries.filter((entry) => entry.idx >= 139))
      await client.exec(readFileSync(`${directory}/${migration.tag}.sql`, "utf8"));
    const networks = createServerClusterRepo(db);
    const clusters = createComputeClusterRepo(db);
    expect((await clusters.list("org")).map((cluster) => cluster.id).sort()).toEqual([
      "native",
      "ready",
    ]);
    expect((await clusters.get("org", "native")).serverIds).toEqual(["native-a", "native-b"]);
    expect((await networks.get("org", "native")).verification?.id).toBe("verification");
    expect((await networks.get("org", "ready")).network.id).toBe("config:ready");
    const saved = await networks.getOperation("org", "op:initial");
    expect(saved).toMatchObject({
      clusterId: "initial",
      planHash: operation.planHash,
      generation: 2,
      status: "interrupted",
    });
    expect(saved.plan).toEqual(operation.plan);
    expect(saved.hosts).toEqual(operation.hosts);
    expect((await db.select().from(schema.managedNetworkPreparation))[0]?.input).toEqual(
      preparation.input,
    );
    expect((await db.select().from(schema.managedNetworkClaim))[0]).toMatchObject({
      clusterId: "initial",
      operationId: "op:initial",
    });
    expect(
      (await client.query("SELECT openship_has_managed_network_state($1) AS active", ["org"])).rows,
    ).toEqual([{ active: true }]);
    // A saved first setup can still claim its rollback; the migration added no pool dependency.
    const recovery = await networks.claimOperation("org", saved.id, saved.planHash, "rollback");
    expect(recovery).toMatchObject({
      started: true,
      operation: { status: "rolling_back", generation: 3 },
    });
  }, 30_000);
});
