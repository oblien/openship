import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { clusterRuntimeFixture } from "../../contracts/test/cluster-runtime-fixtures";
import {
  clusterCapabilitiesFixture,
  clusterInputFixture,
  serverClusterFixture,
} from "../../contracts/test/server-cluster-fixtures";
import {
  managedOperationFixture,
  managedPlanInputFixture,
  managedPreparationFixture,
  managedPreparationSummaryFixture,
} from "../../contracts/test/managed-network-fixtures";

describe("cluster HTTP facade", () => {
  it("uses the runtime endpoints with revision and sequence preconditions", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(clusterRuntimeFixture());
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const clusterId = "pool/a";
    const requestId = "request-1234567890";
    await client.servers.getClusterRuntime({ clusterId });
    await client.servers.setupClusterRuntime({ clusterId, revision: 3, requestId });
    await client.servers.retryClusterRuntime({ clusterId, sequence: 4 });
    await client.servers.removeClusterRuntime({ clusterId, sequence: 5 });
    expect(calls).toEqual([
      { url: "https://ship.test/api/system/compute-clusters/pool%2Fa/runtime", method: "GET", body: undefined },
      { url: "https://ship.test/api/system/compute-clusters/pool%2Fa/runtime", method: "POST", body: { revision: 3, requestId } },
      { url: "https://ship.test/api/system/compute-clusters/pool%2Fa/runtime/retry", method: "POST", body: { sequence: 4 } },
      { url: "https://ship.test/api/system/compute-clusters/pool%2Fa/runtime", method: "DELETE", body: { sequence: 5 } },
    ]);
    await expect(client.servers.removeClusterRuntime({ clusterId, sequence: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("revises connections through the network preparation endpoint with an immutable request ID", async () => {
    const fetcher = vi.fn(async () => Response.json(managedPreparationFixture()));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const request = {
      preparationId: "setup/a",
      sequence: 3,
      requestId: "bbbbbbbb-2222-4222-8222-222222222222",
      access: {
        version: 1 as const,
        rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
      },
    };
    await client.servers.reviseManagedNetworkAccess(request);
    expect(fetcher).toHaveBeenCalledWith(
      "https://ship.test/api/system/networks/preparations/setup%2Fa/connections",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          sequence: request.sequence,
          requestId: request.requestId,
          access: request.access,
        }),
      }),
    );
    await expect(
      client.servers.reviseManagedNetworkAccess({
        ...request,
        access: { version: 1, rules: [request.access.rules[0]!, request.access.rules[0]!] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("sends an explicit speed pair through the existing verification operation", async () => {
    const speedTest = { sourceServerId: "server-a", targetServerId: "server-b" };
    const fetcher = vi.fn(async () =>
      Response.json({
        id: "check",
        clusterId: "cluster/a",
        revision: 2,
        status: "running",
        report: { stage: "inspecting", hosts: [], peers: [], speedTest, throughput: [] },
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      }),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await client.servers.verifyCluster({ clusterId: "cluster/a", revision: 2, speedTest });
    expect(fetcher).toHaveBeenCalledWith(
      "https://ship.test/api/system/clusters/cluster%2Fa/verify",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ revision: 2, speedTest }) }),
    );
  });
  it("removes a setup member with a stable request and review preconditions while keeping path IDs out of the body", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        preparation: { ...managedPreparationFixture(), status: "pending" },
        operation: managedOperationFixture(),
      });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const requestId = "bbbbbbbb-2222-4222-8222-222222222222";
    await client.servers.removeManagedNetworkPreparationMember({
      preparationId: "setup/a",
      serverId: "server/c",
      sequence: 4,
      requestId,
    });
    await client.servers.removeManagedNetworkOperationMember({
      operationId: "plan/a",
      serverId: "server/c",
      sequence: 6,
      planHash: managedOperationFixture().planHash,
      requestId,
    });
    expect(calls).toEqual([
      {
        url: "https://ship.test/api/system/networks/preparations/setup%2Fa/members/server%2Fc",
        method: "DELETE",
        body: { sequence: 4, requestId },
      },
      {
        url: "https://ship.test/api/system/networks/operations/plan%2Fa/members/server%2Fc",
        method: "DELETE",
        body: { sequence: 6, requestId, planHash: managedOperationFixture().planHash },
      },
    ]);
    await expect(
      client.servers.removeManagedNetworkPreparationMember({
        preparationId: "setup",
        serverId: "server",
        sequence: 0,
        requestId,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      client.servers.removeManagedNetworkOperationMember({
        operationId: "plan",
        serverId: "server",
        sequence: 1,
        requestId,
        planHash: managedOperationFixture().planHash,
        force: true,
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("discards preparations and plans with preconditions and no path IDs in the request body", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          ...(String(url).includes("/preparations")
            ? managedPreparationFixture()
            : managedOperationFixture()),
          status: "cancelled",
        });
      }),
    });
    await client.servers.discardManagedNetworkPreparation({
      preparationId: "setup/a",
      sequence: 7,
    });
    await client.servers.discardManagedNetworkPlan({
      operationId: "plan/a",
      planHash: managedOperationFixture().planHash,
    });
    expect(calls).toEqual([
      {
        url: "https://ship.test/api/system/networks/preparations/setup%2Fa",
        method: "DELETE",
        body: { sequence: 7 },
      },
      {
        url: "https://ship.test/api/system/networks/operations/plan%2Fa",
        method: "DELETE",
        body: { planHash: managedOperationFixture().planHash },
      },
    ]);
  });
  it("opens replayable progress subscriptions with GET and propagates cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'event: snapshot\nid: 4\ndata: {"type":"snapshot","run":{"sequence":4}}\n\nevent: complete\ndata: {"type":"complete"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const abort = new AbortController();
    for (const source of [
      client.servers.managedNetworkPreparationEvents("setup/a", { signal: abort.signal }),
      client.servers.managedNetworkOperationEvents("op/a", { signal: abort.signal }),
      client.servers.clusterEvents({ signal: abort.signal }),
      client.servers.clusterRuntimeEvents("pool/a", { signal: abort.signal }),
    ]) {
      const frames = [];
      for await (const event of source) frames.push(event);
      expect(frames.map((event) => event.event)).toEqual(["snapshot", "complete"]);
      expect(frames[0]!.id).toBe("4");
    }
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://ship.test/api/system/networks/preparations/setup%2Fa/stream",
      "https://ship.test/api/system/networks/operations/op%2Fa/stream",
      "https://ship.test/api/system/networks/stream",
      "https://ship.test/api/system/compute-clusters/pool%2Fa/runtime/stream",
    ]);
    abort.abort();
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.signal?.aborted).toBe(true);
    }
  });
  it("starts preparation and reads its saved progress without sending path IDs as query parameters", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json(
          String(url).endsWith("/preparations") && init?.method !== "POST"
            ? [managedPreparationSummaryFixture()]
            : managedPreparationFixture(),
        );
      }),
    });
    await client.servers.prepareManagedNetwork(managedPlanInputFixture());
    await client.servers.getManagedNetworkPreparation({ preparationId: "setup/a" });
    await client.servers.listManagedNetworkPreparations();
    expect(calls).toEqual([
      {
        url: "https://ship.test/api/system/networks/preparations",
        method: "POST",
        body: managedPlanInputFixture(),
      },
      {
        url: "https://ship.test/api/system/networks/preparations/setup%2Fa",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://ship.test/api/system/networks/preparations",
        method: "GET",
        body: undefined,
      },
    ]);
  });
  it("uses review, operation lookup and apply routes without sending path IDs in bodies", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const operation = managedOperationFixture();
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json(operation);
      }),
    });
    const input = managedPlanInputFixture();
    await client.servers.planManagedNetwork(input);
    await client.servers.getManagedNetworkOperation({ operationId: "operation/a" });
    await client.servers.applyManagedNetwork({
      operationId: "operation/a",
      planHash: operation.planHash,
      action: "apply",
    });
    expect(calls).toEqual([
      { url: "https://ship.test/api/system/networks/plans", method: "POST", body: input },
      {
        url: "https://ship.test/api/system/networks/operations/operation%2Fa",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://ship.test/api/system/networks/operations/operation%2Fa/apply",
        method: "POST",
        body: { planHash: operation.planHash, action: "apply" },
      },
    ]);
  });
  it("rejects unreviewed mutation fields and secret-bearing network responses", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...managedOperationFixture(), privateKey: "must-not-be-public" }),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(
      client.servers.applyManagedNetwork({
        operationId: "operation",
        planHash: "b".repeat(64),
        action: "apply",
        config: {},
        command: "anything",
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      client.servers.getManagedNetworkOperation({ operationId: "operation" }),
    ).rejects.toThrow("Invalid getManagedNetworkOperation response");
  });
  it("uses the cluster routes and strips the path identifier from mutations", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const cluster = serverClusterFixture();
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(url).endsWith("/capabilities"))
          return Response.json(clusterCapabilitiesFixture());
        if (init?.method === "DELETE") return Response.json({ removed: true });
        return Response.json(cluster);
      }),
    });
    const input = clusterInputFixture();
    await client.servers.clusterCapabilities();
    await client.servers.createCluster(input);
    await client.servers.getCluster({ clusterId: "cluster/a" });
    const { requestId: _requestId, ...config } = input;
    await client.servers.updateCluster({ ...config, clusterId: "cluster/a", revision: 1 });
    await client.servers.removeCluster({ clusterId: "cluster/a", revision: 1 });
    expect(calls).toEqual([
      { url: "https://ship.test/api/system/clusters/capabilities", method: "GET", body: undefined },
      { url: "https://ship.test/api/system/clusters", method: "POST", body: input },
      { url: "https://ship.test/api/system/clusters/cluster%2Fa", method: "GET", body: undefined },
      {
        url: "https://ship.test/api/system/clusters/cluster%2Fa",
        method: "PATCH",
        body: { ...config, revision: 1 },
      },
      {
        url: "https://ship.test/api/system/clusters/cluster%2Fa",
        method: "DELETE",
        body: { revision: 1 },
      },
    ]);
  });
  it("rejects malformed responses and invalid inputs", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ id: "cluster-a", network: { mode: "wireguard" } }),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(client.servers.getCluster({ clusterId: "cluster-a" })).rejects.toThrow(
      "Invalid getCluster response",
    );
    fetcher.mockClear();
    await expect(
      client.servers.createCluster({ ...clusterInputFixture(), members: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
