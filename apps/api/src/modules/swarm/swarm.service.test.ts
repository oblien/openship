import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import { createSwarmDiscoveryService } from "./swarm.service";

const manager = {
  engineVersion: "29.0.0",
  apiVersion: "1.52",
  localNodeState: "active" as const,
  controlAvailable: true as const,
  clusterId: "cluster-a",
  nodeId: "node-a",
  nodeAddress: null,
  managerAddress: null,
};

function snapshot(): SwarmDiscoverySnapshot {
  return {
    manager,
    nodes: [{ id: "node-a", hostname: "manager", status: "Ready", availability: "Active", managerStatus: "Leader", engineVersion: null, labels: {} }],
    stacks: [{ name: "blog", serviceIds: ["svc-a"], serviceNames: ["web"] }],
    services: [{
      id: "svc-a", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 1,
      mode: "replicated", desiredReplicas: 1, image: "repo/web@sha256:abc", loggingDriver: null, labels: { "traefik.http.routers.web.rule": "Host(`app.example.test`)" }, endpointMode: null,
      placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null,
      networks: [], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null,
    }],
    tasks: [{ id: "task-a", serviceId: "svc-a", serviceName: "blog_web", slot: 1, nodeId: "node-a", nodeName: "manager", desiredState: "Running", currentState: "Running 1 second ago", error: null, image: "repo/web@sha256:abc", updatedAt: null, observedAt: "2026-07-30T00:00:00.000Z" }],
    networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function service(overrides: Parameters<typeof createSwarmDiscoveryService>[0] = {}) {
  const discover = vi.fn().mockResolvedValue(snapshot());
  const probe = vi.fn().mockResolvedValue(manager);
  const resolvePlatform = vi.fn().mockResolvedValue({ stackRuntime: { name: "swarm", discover, probe } });
  return {
    discover,
    probe,
    resolvePlatform,
    service: createSwarmDiscoveryService({
      featureEnabled: () => true,
      getServer: async (id) => ({ id }) as never,
      resolvePlatform,
      now: () => 100,
      ...overrides,
    }),
  };
}

describe("Swarm discovery service", () => {
  it("uses a short per-org/server cache and derives stack health without a mutation surface", async () => {
    const fixture = service();
    const first = await fixture.service.summary("server-a", "org-a");
    const second = await fixture.service.summary("server-a", "org-a");

    expect(first.stacks[0]?.state).toBe("ready");
    expect(second.stacks[0]?.services[0]?.state).toBe("converged");
    expect(fixture.discover).toHaveBeenCalledTimes(1);
    expect(fixture.resolvePlatform).toHaveBeenCalledWith("server", "docker", "server-a", "org-a", "swarm");
  });

  it("returns only read-only, redacted router metadata from stack detail", async () => {
    const fixture = service();
    const detail = await fixture.service.stack("server-a", "org-a", "blog");

    expect(detail.services[0]).toMatchObject({
      routingLabels: [{ key: "traefik.http.routers.web.rule", value: "Host(`app.example.test`)", redacted: false }],
      routingUrls: ["https://app.example.test"],
    });
    expect(detail.services[0]).not.toHaveProperty("labels");
  });

  it("fails closed when the feature is disabled", async () => {
    const fixture = service({ featureEnabled: () => false });
    await expect(fixture.service.probe("server-a", "org-a")).rejects.toMatchObject({
      statusCode: 404,
      code: "SWARM_FEATURE_DISABLED",
    });
  });

  it("does not resolve a manager for a server outside the request organization", async () => {
    const fixture = service({ getServer: async () => undefined });
    await expect(fixture.service.probe("server-b", "org-a")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(fixture.resolvePlatform).not.toHaveBeenCalled();
  });

  it("returns a stable unavailable error for unexpected manager transport failures", async () => {
    const fixture = service({ resolvePlatform: async () => { throw new Error("ssh secret should not escape"); } });
    await expect(fixture.service.probe("server-a", "org-a")).rejects.toEqual(
      expect.objectContaining({ statusCode: 503, code: "SWARM_MANAGER_UNAVAILABLE" }),
    );
  });
});
