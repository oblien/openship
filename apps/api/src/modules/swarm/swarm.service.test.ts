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
    nodes: [
      {
        id: "node-a",
        hostname: "manager",
        status: "Ready",
        availability: "Active",
        managerStatus: "Leader",
        engineVersion: null,
        labels: {},
      },
    ],
    stacks: [{ name: "blog", serviceIds: ["svc-a"], serviceNames: ["web"] }],
    services: [
      {
        id: "svc-a",
        name: "blog_web",
        sourceServiceName: "web",
        stackName: "blog",
        specVersion: 1,
        mode: "replicated",
        desiredReplicas: 1,
        image: "repo/web@sha256:abc",
        loggingDriver: null,
        labels: { "traefik.http.routers.web.rule": "Host(`app.example.test`)" },
        endpointMode: null,
        placement: null,
        resources: null,
        updateConfig: null,
        rollbackConfig: null,
        restartPolicy: null,
        networks: [],
        configs: [],
        secrets: [],
        publishedPorts: [],
        updateState: null,
        updateMessage: null,
      },
    ],
    tasks: [
      {
        id: "task-a",
        serviceId: "svc-a",
        serviceName: "blog_web",
        slot: 1,
        nodeId: "node-a",
        nodeName: "manager",
        desiredState: "Running",
        currentState: "Running 1 second ago",
        error: null,
        image: "repo/web@sha256:abc",
        updatedAt: null,
        observedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
    networks: [],
    volumes: [],
    configs: [],
    secrets: [],
    diagnostics: [],
    observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function service(
  overrides: Parameters<typeof createSwarmDiscoveryService>[0] = {},
  snapshotValue: SwarmDiscoverySnapshot = snapshot(),
) {
  const discover = vi.fn().mockResolvedValue(snapshotValue);
  const probe = vi.fn().mockResolvedValue(manager);
  const resolvePlatform = vi
    .fn()
    .mockResolvedValue({ stackRuntime: { name: "swarm", discover, probe } });
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
    expect(fixture.resolvePlatform).toHaveBeenCalledWith(
      "server",
      "docker",
      "server-a",
      "org-a",
      "swarm",
    );
  });

  it("coalesces concurrent dashboard reads into one bounded manager discovery", async () => {
    const fixture = service();
    const [summary, detail, raw] = await Promise.all([
      fixture.service.summary("server-a", "org-a"),
      fixture.service.stack("server-a", "org-a", "blog"),
      fixture.service.discover("server-a", "org-a"),
    ]);

    expect(summary.stacks[0]?.stackName).toBe("blog");
    expect(detail.tasks).toHaveLength(1);
    expect(raw.services).toHaveLength(1);
    expect(fixture.discover).toHaveBeenCalledTimes(1);
  });

  it("pages a large task history without inflating the stack-detail response", async () => {
    const base = snapshot();
    const large = {
      ...base,
      tasks: Array.from({ length: 2_000 }, (_, index) => ({
        ...base.tasks[0]!,
        id: `task-${index.toString().padStart(4, "0")}`,
        slot: index + 1,
      })),
    };
    const fixture = service({}, large);

    const first = await fixture.service.stack("server-a", "org-a", "blog");
    const second = await fixture.service.stack("server-a", "org-a", "blog", {
      taskOffset: 100,
      taskLimit: 100,
    });

    expect(first).toMatchObject({
      tasks: expect.any(Array),
      taskPage: { offset: 0, limit: 100, total: 2_000, hasNext: true },
    });
    expect(first.tasks).toHaveLength(100);
    expect(first.health.services[0]).not.toHaveProperty("currentTasks");
    expect(second).toMatchObject({ taskPage: { offset: 100, limit: 100, hasPrevious: true } });
    expect(second.tasks).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(100_000);
  });

  it("returns only read-only, redacted router metadata from stack detail", async () => {
    const fixture = service();
    const detail = await fixture.service.stack("server-a", "org-a", "blog");

    expect(detail.services[0]).toMatchObject({
      routingLabels: [
        {
          key: "traefik.http.routers.web.rule",
          value: "Host(`app.example.test`)",
          redacted: false,
        },
      ],
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
    const fixture = service({
      resolvePlatform: async () => {
        throw new Error("ssh secret should not escape");
      },
    });
    await expect(fixture.service.probe("server-a", "org-a")).rejects.toEqual(
      expect.objectContaining({ statusCode: 503, code: "SWARM_MANAGER_UNAVAILABLE" }),
    );
  });
});
