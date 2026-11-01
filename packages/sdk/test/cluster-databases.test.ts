import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import type { ClusterDatabase } from "@repo/contracts";

const config = {
  engine: "postgres" as const,
  mode: "cluster" as const,
  instances: 3,
  cpuMillis: 500,
  memoryMiB: 512,
  storageGiB: 20,
  storageClass: "openship-local",
  databaseName: "app",
  backup: { destinationId: "archives", schedule: "daily" as const, retentionDays: 30 },
};
const identity = { databaseId: "database", expectedSequence: 8 };

describe("project database SDK", () => {
  it("uses the shared lifecycle endpoints without losing restore or concurrency preconditions", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const view: ClusterDatabase = {
      id: identity.databaseId,
      projectId: "project/a",
      clusterId: "cluster",
      name: "postgres",
      config,
      sequence: identity.expectedSequence,
      generation: 2,
      status: "ready",
      intent: "apply",
      progress: { steps: [], logs: [] },
      observation: null,
      error: null,
      envKey: null,
      internalHost: "database-rw.private.svc.cluster.local",
      readOnlyHost: "database-ro.private.svc.cluster.local",
      createdAt: "2026-09-21T12:00:00.000Z",
      updatedAt: "2026-09-21T12:30:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ data: init?.method === "GET" ? [view] : view });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const create = {
      requestId: "faaa1111-2222-4333-8444-555555555555",
      name: "recovered",
      config,
      restoreFrom: { databaseId: "source", backupName: "saved-backup" },
    };
    const inspect = { databaseId: "database", observe: true };
    const update = { ...identity, config: { ...config, instances: 4 } };
    const connect = { ...identity, envKey: "DATABASE_URL" };
    const remove = { ...identity, name: "postgres", deleteData: false };
    expect(await client.projects.listClusterDatabases("project/a")).toEqual([view]);
    expect(await client.projects.getClusterDatabase("project/a", inspect)).toEqual(view);
    expect(await client.projects.createClusterDatabase("project/a", create)).toEqual(view);
    await client.projects.updateClusterDatabase("project/a", update);
    await client.projects.retryClusterDatabase("project/a", identity);
    await client.projects.backupClusterDatabase("project/a", identity);
    await client.projects.connectClusterDatabase("project/a", connect);
    await client.projects.removeClusterDatabase("project/a", remove);
    const path = "https://ship.test/api/projects/project%2Fa/cluster/databases";
    expect(calls).toEqual([
      { url: path, method: "GET", body: undefined },
      { url: path + "/inspect", method: "POST", body: inspect },
      { url: path, method: "POST", body: create },
      { url: path, method: "PATCH", body: update },
      { url: path + "/retry", method: "POST", body: identity },
      { url: path + "/backup", method: "POST", body: identity },
      { url: path + "/connect", method: "POST", body: connect },
      { url: path, method: "DELETE", body: remove },
    ]);
    await expect(
      client.projects.removeClusterDatabase("project/a", { ...remove, expectedSequence: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      client.projects.createClusterDatabase("project/a", {
        ...create,
        requestId: "invalid-request",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      client.projects.createClusterDatabase("project/a", {
        ...create,
        secretEncrypted: "client-selected-credential",
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it("receives durable database snapshots over SSE and propagates cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'event: snapshot\nid: 8\ndata: {"type":"snapshot","run":[{"id":"database","sequence":8}]}\n\nevent: complete\ndata: {"type":"complete"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const controller = new AbortController();
    const events = [];
    for await (const event of client.projects.streamClusterDatabaseEvents("project/a", {
      signal: controller.signal,
    }))
      events.push(event);
    expect(events.map((event) => event.event)).toEqual(["snapshot", "complete"]);
    expect(events[0]?.id).toBe("8");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://ship.test/api/projects/project%2Fa/cluster/databases/stream",
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
    controller.abort();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
