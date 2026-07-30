import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot, SwarmServiceState } from "./types";
import { SWARM_EDGE_INGRESS_LABEL, SWARM_EDGE_SERVICE_NAME } from "./edge";
import { SwarmEdgeCutoverManager } from "./cutover";

function router(overrides: Partial<SwarmServiceState> = {}): SwarmServiceState {
  return {
    id: "router-service-123",
    name: "legacy_traefik",
    sourceServiceName: "traefik",
    stackName: "legacy",
    specVersion: 7,
    mode: "replicated",
    desiredReplicas: 2,
    image: "traefik:v3",
    labels: { "com.docker.stack.namespace": "legacy" },
    endpointMode: null,
    placement: null,
    resources: null,
    updateConfig: null,
    rollbackConfig: null,
    restartPolicy: null,
    networks: [], configs: [], secrets: [],
    publishedPorts: [
      { target: 80, published: 80, protocol: "tcp", mode: "ingress" },
      { target: 443, published: 443, protocol: "tcp", mode: "ingress" },
    ],
    updateState: null,
    updateMessage: null,
    ...overrides,
  };
}

function edge(): SwarmServiceState {
  return {
    ...router({
      id: "edge-service-123",
      name: SWARM_EDGE_SERVICE_NAME,
      sourceServiceName: SWARM_EDGE_SERVICE_NAME,
      stackName: null,
      desiredReplicas: 1,
      labels: { "com.openship.edge": "swarm" },
      publishedPorts: [
        { target: 80, published: 80, protocol: "tcp", mode: "host" },
        { target: 443, published: 443, protocol: "tcp", mode: "host" },
      ],
    }),
  };
}

function snapshot(services: SwarmServiceState[], edgeTask = false): SwarmDiscoverySnapshot {
  return {
    manager: { engineVersion: "29", apiVersion: "1.52", localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
    nodes: [{ id: "node-a", hostname: "manager", status: "ready", availability: "active", managerStatus: "leader", engineVersion: "29", labels: { [SWARM_EDGE_INGRESS_LABEL]: "true" } }],
    stacks: [], services,
    tasks: edgeTask ? [{ id: "edge-task", serviceId: "edge-service-123", serviceName: SWARM_EDGE_SERVICE_NAME, slot: 1, nodeId: "node-a", nodeName: "manager", desiredState: "Running", currentState: "Running", error: null, image: "edge", updatedAt: null, observedAt: "2026-07-30T00:00:00.000Z" }] : [],
    networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("SwarmEdgeCutoverManager", () => {
  it("plans a replicated Swarm router as an explicit reversible scale-and-unpublish operation", async () => {
    const manager = new SwarmEdgeCutoverManager(
      { probe: vi.fn(), discover: vi.fn().mockResolvedValue(snapshot([router()])) },
      { exec: vi.fn(), writeFile: vi.fn(), rm: vi.fn() },
    );
    await expect(manager.plan()).resolves.toMatchObject({
      kind: "swarm-service",
      serviceId: "router-service-123",
      specVersion: 7,
      replicas: 2,
      strategy: "scale-and-remove-published-ports",
    });
  });

  it("journals, unpublishes, enables Edge, and never addresses a task container", async () => {
    const stoppedRouter = router({ desiredReplicas: 0, publishedPorts: [] });
    const runningEdge = {
      ...snapshot([stoppedRouter, edge()], true),
      configs: [{
        id: "route-config-1",
        name: "openship-edge-route-app-example",
        labels: { "com.openship.edge.route": "true", "com.openship.edge.domain": "app.example.com" },
        createdAt: null,
      }],
    };
    const discover = vi.fn()
      .mockResolvedValueOnce(snapshot([router()]))
      .mockResolvedValueOnce(snapshot([stoppedRouter]))
      .mockResolvedValueOnce(snapshot([stoppedRouter]))
      .mockResolvedValueOnce(runningEdge)
      .mockResolvedValueOnce(runningEdge)
      .mockResolvedValueOnce(runningEdge);
    const commands: string[] = [];
    const manager = new SwarmEdgeCutoverManager(
      { probe: vi.fn(), discover },
      {
        exec: vi.fn(async (command: string) => {
          commands.push(command);
          if (command.startsWith("docker config ls")) return "";
          if (command.startsWith("umask 077")) return "/tmp/openship-swarm-edge-cutover.abc123";
          if (command.includes("network inspect") || command.includes("service inspect")) return "";
          if (command.startsWith("docker service create")) return "edgecreated123";
          return "";
        }),
        writeFile: vi.fn(async () => {}),
        rm: vi.fn(async () => {}),
      },
    );

    await expect(manager.execute({ serviceId: "router-service-123", specVersion: 7 })).resolves.toEqual({
      edgeServiceId: "edge-service-123",
      previousServiceName: "legacy_traefik",
      healthVerified: true,
      servedRoutes: ["app.example.com"],
    });
    const all = commands.join("\n");
    expect(all).toContain("docker config create");
    expect(all).toContain("--replicas 0 'router-service-123'");
    expect(all).toContain("--publish-rm 'target=80,published=80,protocol=tcp,mode=ingress'");
    expect(all).toContain("docker service create");
    expect(all).toContain("openship-edge-cutover-health-");
    expect(all).toContain("curl -sS --connect-timeout 5 --max-time 10 -o /dev/null http://openship-edge/");
    expect(all).toContain("Host: app.example.com");
    expect(all).not.toContain("docker exec");
  });

  it("restores the original port publications and replicas if Edge creation fails", async () => {
    const stoppedRouter = router({ desiredReplicas: 0, publishedPorts: [] });
    const discover = vi.fn()
      .mockResolvedValueOnce(snapshot([router()]))
      .mockResolvedValueOnce(snapshot([stoppedRouter]))
      .mockResolvedValueOnce(snapshot([stoppedRouter]))
      .mockResolvedValueOnce(snapshot([stoppedRouter]));
    const commands: string[] = [];
    const manager = new SwarmEdgeCutoverManager(
      { probe: vi.fn(), discover },
      {
        exec: vi.fn(async (command: string) => {
          commands.push(command);
          if (command.startsWith("docker config ls")) return "";
          if (command.startsWith("umask 077")) return "/tmp/openship-swarm-edge-cutover.abc123";
          if (command.includes("network inspect") || command.includes("service inspect")) return "";
          if (command.startsWith("docker service create")) throw new Error("edge scheduler rejected the task");
          return "";
        }),
        writeFile: vi.fn(async () => {}),
        rm: vi.fn(async () => {}),
      },
    );

    await expect(manager.execute({ serviceId: "router-service-123", specVersion: 7 }))
      .rejects.toThrow(/previous router was restored/);
    const all = commands.join("\n");
    expect(all).toContain("--publish-add 'target=80,published=80,protocol=tcp,mode=ingress'");
    expect(all).toContain("--replicas 2 'router-service-123'");
  });

  it("recovers an interrupted cutover from its persisted manager journal", async () => {
    const stoppedRouter = router({ desiredReplicas: 0, publishedPorts: [] });
    const journal = {
      version: 1,
      serviceId: "routerservice123",
      serviceName: "legacy_traefik",
      replicas: 2,
      ports: [
        { target: 80, published: 80, protocol: "tcp", mode: "ingress" },
        { target: 443, published: 443, protocol: "tcp", mode: "ingress" },
      ],
    };
    const commands: string[] = [];
    const manager = new SwarmEdgeCutoverManager(
      { probe: vi.fn(), discover: vi.fn().mockResolvedValue(snapshot([stoppedRouter])) },
      {
        exec: vi.fn(async (command: string) => {
          commands.push(command);
          if (command.startsWith("docker config ls")) return "openship-edge-cutover-example";
          if (command.startsWith("docker config inspect")) {
            return JSON.stringify(Buffer.from(JSON.stringify(journal)).toString("base64"));
          }
          return "";
        }),
        writeFile: vi.fn(),
        rm: vi.fn(),
      },
    );

    await expect(manager.recover()).resolves.toMatchObject({ recovered: true, message: expect.stringContaining("Restored legacy_traefik") });
    const all = commands.join("\n");
    expect(all).toContain("--publish-add 'target=80,published=80,protocol=tcp,mode=ingress'");
    expect(all).toContain("--publish-add 'target=443,published=443,protocol=tcp,mode=ingress'");
    expect(all).toContain("--replicas 2 'routerservice123'");
    expect(all).toContain("docker config rm 'openship-edge-cutover-example'");
  });
});
