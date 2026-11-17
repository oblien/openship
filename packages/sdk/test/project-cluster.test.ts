import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";

describe("project cluster SDK", () => {
  it("uses the shared authorization contract and correct service scope for single-server replicas", async () => {
    const view = { replicas: 3, activeReplicas: 2, activeDeploymentId: "active", updatedAt: "revision", serviceId: "service/a", status: null, unavailableReason: null, error: null };
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({ data: init?.method === "POST" ? { deploymentId: "next" } : view }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    expect(await client.projects.getWorkloadScaling("project/a", { serviceId: "service/a" })).toEqual(view);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://ship.test/api/projects/project%2Fa/scaling?serviceId=service%2Fa");
    const request = { serviceId: "service/a", replicas: 3, expectedDeploymentId: "active", expectedUpdatedAt: "revision" };
    expect(await client.projects.scaleWorkload("project/a", request)).toEqual({ deploymentId: "next" });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(request);
    await expect(client.projects.scaleWorkload("project/a", { ...request, replicas: 101 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("shares target and replica preconditions with the HTTP lifecycle", async () => {
    const view = {
      clusterId: "cluster",
      config: { replicas: 3 },
      updatedAt: "2026-09-21T09:00:00.000Z",
      activeDeploymentId: "release",
      activeClusterId: "cluster",
      internalHost: null,
      status: null,
      error: null,
    };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({
        data: String(url).endsWith("/scale") ? { deploymentId: "scale-release" } : view,
      });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    expect(await client.projects.getClusterWorkload("project/a")).toEqual(view);
    const target = {
      clusterId: "cluster",
      config: { replicas: 3 },
      expectedUpdatedAt: view.updatedAt,
      stateless: true as const,
    };
    await client.projects.setClusterTarget("project/a", target);
    const scale = {
      replicas: 4,
      expectedUpdatedAt: view.updatedAt,
      expectedDeploymentId: "release",
    };
    expect(await client.projects.scaleClusterWorkload("project/a", scale)).toEqual({
      deploymentId: "scale-release",
    });
    expect(calls).toEqual([
      { url: "https://ship.test/api/projects/project%2Fa/cluster", method: "GET", body: undefined },
      { url: "https://ship.test/api/projects/project%2Fa/cluster", method: "PATCH", body: target },
      {
        url: "https://ship.test/api/projects/project%2Fa/cluster/scale",
        method: "POST",
        body: scale,
      },
    ]);
    await expect(
      client.projects.scaleClusterWorkload("project/a", { ...scale, replicas: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
