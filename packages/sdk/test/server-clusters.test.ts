import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import {
  clusterCapabilitiesFixture,
  clusterInputFixture,
  serverClusterFixture,
} from "../../contracts/test/server-cluster-fixtures";

describe("cluster HTTP facade", () => {
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
