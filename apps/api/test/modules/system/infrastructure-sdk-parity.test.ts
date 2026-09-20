import { afterEach, describe, expect, it, vi } from "vitest";
import { seedOwner, seedServer, type SeededOwner } from "../jobs/_harness";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { serverManagementRoutes } from "../../../src/modules/system/server-management.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { createHash } from "node:crypto";
import { normalizeManagedNetworkInput } from "@repo/core";
import { managedPreparationFixture } from "../../../../../packages/contracts/test/managed-network-fixtures";
import {
  networkPreparationCollection,
  presentNetworkPreparation,
} from "@repo/platform/engine/modules/system/network-preparation.operations";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/system", serverManagementRoutes);
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "infrastructure-test",
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
  return { native: native.servers, remote: remote.servers };
}
const nativeInput = (serverIds: string[], cidr = "10.20.0.0/24") => ({
  requestId: crypto.randomUUID(),
  name: "Private production",
  network: {
    mode: "native" as const,
    cidrs: [cidr],
    mtu: 1400,
    probePort: 51821,
    source: { providerId: "custom" as const },
  },
  members: serverIds.map((serverId, index) => ({
    serverId,
    providerId: "custom" as const,
    privateIp: cidr.replace("0/24", String(index + 1)),
  })),
});
afterEach(() => vi.restoreAllMocks());

describe("independent infrastructure through native SDK and HTTP", () => {
  it("publishes connection revisions through HTTP and replays them through the native SDK", async () => {
    const hostWork = vi
      .spyOn(sshManager, "withExecutor")
      .mockRejectedValue(new Error("Unexpected host work"));
    const owner = await seedOwner();
    const ids = await Promise.all([
      seedServer(owner.orgId, "Hub"),
      seedServer(owner.orgId, "Data"),
    ]);
    const fixture = managedPreparationFixture(ids);
    const input = normalizeManagedNetworkInput({
      ...fixture.input,
      requestId: crypto.randomUUID(),
    });
    const started = await repos.networkPreparation.start(
      owner.orgId,
      owner.userId,
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      input,
      fixture.hosts,
    );
    await repos.networkPreparation.finish(
      input.requestId,
      started.preparation.generation,
      fixture.hosts,
      null,
      "Server preparation is paused",
    );
    const source = await repos.networkPreparation.get(owner.orgId, input.requestId);
    // Exercise the real contracts, routes, authorization and transaction. Host bootstrap
    // is independently covered by the worker tests and must not run in this HTTP fixture.
    const prepare = vi
      .spyOn(networkPreparationCollection, "prepareManagedNetwork")
      .mockImplementation(async (ctx, next) =>
        presentNetworkPreparation(
          await repos.networkPreparation.get(ctx.organizationId, next.requestId),
        ),
      );
    const { native, remote } = await clients(owner);
    const request = {
      preparationId: source.id,
      sequence: source.sequence,
      requestId: crypto.randomUUID(),
      access: {
        version: 1 as const,
        rules: [{ sourceServerId: ids[0]!, targetServerId: ids[1]! }],
      },
    };
    const revised = await remote.reviseManagedNetworkAccess(request);
    expect(revised).toMatchObject({
      id: request.requestId,
      status: "pending",
      input: { access: request.access },
    });
    expect(revised.input.members.map((member) => member.serverId)).toEqual(ids);
    expect(await native.reviseManagedNetworkAccess(request)).toEqual(revised);
    expect(await remote.getManagedNetworkPreparation({ preparationId: source.id })).toMatchObject({
      status: "cancelled",
      replacementPreparationId: revised.id,
      input: source.input,
    });
    const other = await clients(await seedOwner());
    for (const client of [other.native, other.remote])
      await expect(client.reviseManagedNetworkAccess(request)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(hostWork).not.toHaveBeenCalled();
  });
  it("shares persisted networks and cluster references without launching host work", async () => {
    const hostWork = vi
      .spyOn(sshManager, "withExecutor")
      .mockRejectedValue(new Error("Unexpected host work"));
    const owner = await seedOwner();
    const servers = await Promise.all([
      seedServer(owner.orgId, "API"),
      seedServer(owner.orgId, "Worker"),
      seedServer(owner.orgId, "Data"),
    ]);
    const { native, remote } = await clients(owner);
    const network = await remote.createNetwork(nativeInput(servers));
    expect(await native.getNetwork({ networkId: network.id })).toEqual(network);
    expect(await remote.getCluster({ clusterId: network.id })).toEqual(network);
    expect(await remote.listComputeClusters()).toEqual([]);
    const input = {
      name: "Application pool",
      networkId: network.id,
      serverIds: servers.slice(0, 2),
      requestId: crypto.randomUUID(),
    };
    const cluster = await native.createComputeCluster(input);
    expect(await remote.createComputeCluster(input)).toEqual(cluster);
    expect(await remote.getComputeCluster({ clusterId: cluster.id })).toEqual(cluster);
    expect(await native.infrastructure(servers[0]!)).toEqual(
      await remote.infrastructure(servers[0]!),
    );
    expect(await remote.infrastructure(servers[0]!)).toMatchObject({
      canBrowse: true,
      cluster: { id: cluster.id },
      networks: [{ id: network.id }],
    });
    // A second independent network can attach to the same servers.
    const second = await native.createNetwork(nativeInput(servers, "10.30.0.0/24"));
    expect((await remote.infrastructure(servers[0]!)).networks).toHaveLength(2);
    const updated = await remote.updateComputeCluster({
      clusterId: cluster.id,
      revision: cluster.revision,
      name: "Apps",
      networkId: network.id,
      serverIds: input.serverIds,
    });
    expect(await native.getComputeCluster({ clusterId: cluster.id })).toEqual(updated);
    expect((await remote.getNetwork({ networkId: network.id })).revision).toBe(network.revision);
    for (const client of [native, remote])
      await expect(
        client.removeNetwork({ networkId: network.id, revision: network.revision }),
      ).rejects.toMatchObject({ code: "NETWORK_IN_USE" });
    const abort = new AbortController();
    const stream = remote.clusterEvents({ signal: abort.signal })[Symbol.asyncIterator]();
    try {
      const frame = await stream.next();
      const overview = JSON.parse(frame.value!.data).run;
      expect(overview.networks).toHaveLength(2);
      expect(overview.computeClusters).toMatchObject([{ id: cluster.id, networkId: network.id }]);
      expect(overview.preparations).toEqual([]);
    } finally {
      abort.abort();
      await stream.return?.();
    }
    await remote.removeComputeCluster({ clusterId: cluster.id, revision: updated.revision });
    expect(await native.listComputeClusters()).toEqual([]);
    expect((await native.getNetwork({ networkId: network.id })).members).toHaveLength(3);
    expect((await remote.infrastructure(servers[0]!)).cluster).toBeNull();
    await native.removeNetwork({ networkId: network.id, revision: network.revision });
    expect((await remote.listNetworks()).map((network) => network.id)).toEqual([second.id]);
    expect(hostWork).not.toHaveBeenCalled();
  });

  it("conceals foreign networks, pools and server associations across both transports", async () => {
    const alice = await seedOwner(),
      bob = await seedOwner();
    const ids = await Promise.all([seedServer(alice.orgId), seedServer(alice.orgId)]);
    const a = await clients(alice),
      b = await clients(bob);
    const network = await a.native.createNetwork(nativeInput(ids));
    const pool = await a.native.createComputeCluster({
      name: "Private pool",
      networkId: network.id,
      serverIds: ids,
      requestId: crypto.randomUUID(),
    });
    for (const client of [b.native, b.remote]) {
      expect(await client.listNetworks()).toEqual([]);
      expect(await client.listComputeClusters()).toEqual([]);
      await expect(client.getNetwork({ networkId: network.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(client.getComputeCluster({ clusterId: pool.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(client.infrastructure(ids[0]!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        client.removeComputeCluster({ clusterId: pool.id, revision: pool.revision }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
