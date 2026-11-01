import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ComputeCluster, PrivateNetwork } from "@repo/contracts";
import type { ClusterRuntime } from "@repo/core";
import type { CommandExecutor, K3sHostContext, PrivateNetworkProbe } from "@repo/adapters";

// Keep auth, persistence, leases, revisions and engine workflows real. Only the
// host adapters and background scheduling are replaced with a disposable lab.
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  executors: new Map<string, CommandExecutor & { serverId: string; privateIp: string }>(),
  queue: [] as Array<(signal: AbortSignal) => Promise<unknown>>,
  inspect: vi.fn(),
  install: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../../src/app", () => ({ app: { fetch: h.fetch } }));
vi.mock("@repo/platform/engine/lib/ssh-manager", async (original) => ({
  ...(await original<object>()),
  sshManager: {
    withExecutor: async (id: string, work: (executor: CommandExecutor) => Promise<unknown>) => {
      const executor = h.executors.get(id);
      if (!executor) throw new Error("The MCP test cannot connect outside its fixture");
      return work(executor);
    },
  },
}));
vi.mock("@repo/platform/engine/lib/host-port-target", async (original) => ({
  ...(await original<object>()),
  inspectHostIssuedIdentity: async (executor: { serverId: string }) =>
    `machine-${executor.serverId}`,
}));
vi.mock("@repo/platform/engine/modules/system/network-setup-lifecycle", async (original) => ({
  ...(await original<object>()),
  deferNetworkSetupWork: async (
    _metadata: unknown,
    work: (signal: AbortSignal) => Promise<unknown>,
  ) => {
    h.queue.push(work);
  },
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<object>()),
  privateNetworkTools: {
    inspect: async (executor: { privateIp: string }) => [
      {
        name: "eth1",
        mtu: 1500,
        up: true,
        kind: null,
        addresses: [{ address: executor.privateIp, prefixLength: 24 }],
      },
    ],
    listen: async () => {},
    stop: async () => {},
    check: async (_executor: unknown, source: PrivateNetworkProbe, peers: PrivateNetworkProbe[]) =>
      peers.map((peer) => ({
        sourceServerId: source.serverId,
        targetServerId: peer.serverId,
        tcp: true,
        udp: true,
        mtu: true,
        latencyMs: 1,
        message: null,
      })),
  },
  k3sTools: {
    prepare: async () => {},
    inspect: h.inspect,
    install: h.install,
    remove: h.remove,
    resolveVersion: async () => "v1.33.10+k3s1",
    token: async () => `K10${"a".repeat(64)}::server:private-fixture-join-token`,
    ready: async () => ({ ready: true, clusterUid: "fixture-cluster" }),
    nodes: async (_executor: unknown, context: K3sHostContext) => ({
      items: context.plan.hosts.map((host) => ({
        metadata: { name: host.nodeName, labels: { "openship.io/runtime": context.id } },
        status: {
          nodeInfo: { kubeletVersion: context.plan.version },
          addresses: [{ type: "InternalIP", address: host.privateIp }],
          conditions: [{ type: "Ready", status: "True" }],
        },
      })),
    }),
    verifyNetworking: async () => {},
    hasState: async () => ({ hasState: true }),
    assertEmpty: async () => ({ empty: true, clusterUid: "fixture-cluster" }),
  },
}));

import { seedOwner, seedServer, repos } from "../jobs/_harness";
import { serverManagementRoutes } from "../../../src/modules/system/server-management.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { mcpTestClient } from "../../helpers/mcp-client";

const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/system", serverManagementRoutes)
  .route("/api/mcp", mcpRoutes);
beforeAll(() => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  h.fetch.mockImplementation((request: Request) => app.fetch(request));
  h.inspect.mockResolvedValue({
    interfaceName: "eth1",
    ranges: ["10.20.0.0/24"],
    installed: false,
  });
  h.install.mockResolvedValue({ installed: true });
  h.remove.mockResolvedValue({ removed: true });
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
async function drain() {
  while (h.queue.length) await h.queue.shift()!(new AbortController().signal);
}

it("completes network verification → k3s runtime retry → guarded removal through MCP", async () => {
  const owner = await seedOwner({ instanceAdmin: true, bound: true });
  const client = mcpTestClient({
    request: (path, init) => app.request(path, init),
    token: owner.token,
    organizationId: owner.orgId,
  });
  const ids = await Promise.all([
    seedServer(owner.orgId, "control"),
    seedServer(owner.orgId, "worker"),
  ]);
  for (const [index, id] of ids.entries())
    h.executors.set(id, { serverId: id, privateIp: `10.20.0.${index + 2}` } as CommandExecutor & {
      serverId: string;
      privateIp: string;
    });
  const networkInput = {
    requestId: randomUUID(),
    name: "MCP network",
    network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
    members: ids.map((serverId, index) => ({
      serverId,
      providerId: "custom",
      privateIp: `10.20.0.${index + 2}`,
    })),
  };
  const network = await client.call<PrivateNetwork>("post_system_networks", { body: networkInput });
  expect(
    (await client.call<PrivateNetwork>("post_system_networks", { body: networkInput })).id,
  ).toBe(network.id);
  expect(await repos.serverCluster.list(owner.orgId)).toHaveLength(1);
  await client.call("post_system_networks_by_id_verify", {
    id: network.id,
    body: { revision: network.revision },
  });
  expect(h.queue).toHaveLength(1);
  await drain();
  const verified = await client.call<PrivateNetwork>("get_system_networks_by_id", {
    id: network.id,
  });
  expect(verified.verification?.status).toBe("succeeded");
  expect(verified.verification?.report.peers).toHaveLength(2);

  const clusterInput = {
    requestId: randomUUID(),
    name: "MCP compute",
    networkId: network.id,
    serverIds: ids,
  };
  const cluster = await client.call<ComputeCluster>("post_system_compute_clusters", {
    body: clusterInput,
  });
  expect(
    (await client.call<ComputeCluster>("post_system_compute_clusters", { body: clusterInput })).id,
  ).toBe(cluster.id);
  const request = { revision: cluster.revision, requestId: randomUUID() };
  const started = await client.call<ClusterRuntime>("post_system_compute_clusters_by_id_runtime", {
    id: cluster.id,
    body: request,
  });
  expect(started.status).toBe("setting_up");
  const replay = await client.call<ClusterRuntime>("post_system_compute_clusters_by_id_runtime", {
    id: cluster.id,
    body: request,
  });
  expect(replay.id).toBe(started.id);
  expect(h.queue).toHaveLength(1);
  h.inspect.mockRejectedValueOnce(new Error("Fixture host is missing cgroups"));
  await drain();
  const failed = await client.call<ClusterRuntime>("get_system_compute_clusters_by_id_runtime", {
    id: cluster.id,
  });
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("cgroups");
  expect(h.install).not.toHaveBeenCalled();

  await client.call("post_system_compute_clusters_by_id_runtime_retry", {
    id: cluster.id,
    body: { sequence: failed.sequence },
  });
  await drain();
  const ready = await client.call<ClusterRuntime>("get_system_compute_clusters_by_id_runtime", {
    id: cluster.id,
  });
  expect(ready.status).toBe("ready");
  expect(ready.plan.hosts.every((host) => host.ready && host.installed)).toBe(true);
  expect(JSON.stringify(ready)).not.toContain("private-fixture-join-token");
  expect(h.install).toHaveBeenCalledTimes(2);
  expect(
    (await client.call<ComputeCluster>("get_system_compute_clusters_by_id", { id: cluster.id }))
      .scaling?.status,
  ).toBe("ready");

  const stranger = await seedOwner();
  const foreign = mcpTestClient({
    request: (path, init) => app.request(path, init),
    token: stranger.token,
    organizationId: stranger.orgId,
  });
  expect(
    (await foreign.result("get_system_compute_clusters_by_id_runtime", { id: cluster.id })).isError,
  ).toBe(true);
  expect(
    (
      await client.result("delete_system_networks_by_id", {
        id: network.id,
        body: { revision: network.revision },
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await client.result("delete_system_compute_clusters_by_id", {
        id: cluster.id,
        body: { revision: cluster.revision },
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await client.result("delete_system_compute_clusters_by_id_runtime", {
        id: cluster.id,
        body: { sequence: failed.sequence },
      })
    ).isError,
  ).toBe(true);
  expect(h.remove).not.toHaveBeenCalled();

  await client.call("delete_system_compute_clusters_by_id_runtime", {
    id: cluster.id,
    body: { sequence: ready.sequence },
  });
  await drain();
  const removed = await client.call<ClusterRuntime>("get_system_compute_clusters_by_id_runtime", {
    id: cluster.id,
  });
  expect(removed.status).toBe("removed");
  expect(h.remove).toHaveBeenCalledTimes(2);
  const latest = await client.call<ComputeCluster>("get_system_compute_clusters_by_id", {
    id: cluster.id,
  });
  await client.call("delete_system_compute_clusters_by_id", {
    id: cluster.id,
    body: { revision: latest.revision },
  });
  await client.call("delete_system_networks_by_id", {
    id: network.id,
    body: { revision: network.revision },
  });
  expect(await repos.computeCluster.list(owner.orgId)).toEqual([]);
  expect(await repos.serverCluster.list(owner.orgId)).toEqual([]);
}, 30_000);
