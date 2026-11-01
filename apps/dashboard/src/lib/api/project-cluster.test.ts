import { afterEach, describe, expect, it, vi } from "vitest";
import { projectClusterApi } from "./project-cluster";
import { clusterDatabasesApi } from "./cluster-databases";
import type { ClusterDatabase } from "@repo/contracts";
afterEach(() => vi.unstubAllGlobals());
describe("cluster API response boundaries", () => {
  it("unpacks project selection and the deployment ID returned by scaling", async () => {
    const state = { clusterId: "cluster", config: { replicas: 3 } };
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      Response.json({
        data: String(url).endsWith("/scale") ? { deploymentId: "new-release" } : state,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await projectClusterApi.get("project/a")).toEqual(state);
    expect(
      await projectClusterApi.scale("project/a", {
        replicas: 3,
        expectedUpdatedAt: "now",
        expectedDeploymentId: "release",
      }),
    ).toEqual({ deploymentId: "new-release" });
    expect(String(fetch.mock.calls[0]![0])).toContain("/projects/project%2Fa/cluster");
  });
  it("returns database records and sends explicit removal preconditions", async () => {
    const row = { id: "database", projectId: "project", sequence: 17 } as ClusterDatabase;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      Response.json({ data: init?.method === "GET" ? [row] : row }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await clusterDatabasesApi.list("project")).toEqual([row]);
    expect(await clusterDatabasesApi.inspect("project", row.id)).toEqual(row);
    expect(await clusterDatabasesApi.remove("project", row, "postgres", false)).toEqual(row);
    expect(fetch.mock.calls[2]![1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({
      databaseId: "database",
      expectedSequence: 17,
      name: "postgres",
      deleteData: false,
    });
  });
});
