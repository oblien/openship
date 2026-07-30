import { describe, expect, it } from "vitest";
import type { SwarmServiceState } from "@repo/adapters";
import type { SwarmServiceProjection } from "@repo/core";
import { classifySwarmSpecDrift } from "./swarm-drift";

const expected: SwarmServiceProjection = {
  sourceServiceName: "web",
  mode: "replicated",
  replicas: { desired: 2 },
  image: "nginx@sha256:old",
  environmentKeys: ["LOG_LEVEL"],
  labels: { "app.example/component": "web" },
  publishedPorts: [{ target: 80, published: 8080, protocol: "tcp", mode: "ingress" }],
  networks: [],
  volumes: [],
  configs: [],
  secrets: [],
  sourceState: "present",
};

const live = (overrides: Partial<SwarmServiceState> = {}): SwarmServiceState => ({
  id: "svc-web",
  name: "blog_web",
  sourceServiceName: "web",
  stackName: "blog",
  specVersion: 2,
  mode: "replicated",
  desiredReplicas: 2,
  image: "nginx@sha256:old",
  environmentKeys: ["LOG_LEVEL"],
  labels: {
    "app.example/component": "web",
    "com.docker.stack.namespace": "blog",
    "com.openship.project-id": "proj-blog",
  },
  endpointMode: null,
  placement: null,
  resources: null,
  updateConfig: null,
  rollbackConfig: null,
  restartPolicy: null,
  networks: [],
  volumes: [],
  configs: [],
  secrets: [],
  publishedPorts: [{ target: 80, published: 8080, protocol: "tcp", mode: "ingress" }],
  updateState: null,
  updateMessage: null,
  ...overrides,
});

describe("managed Swarm drift classification", () => {
  it("ignores manager-resolved image digests and implicit default networks", () => {
    const changes = classifySwarmSpecDrift({
      stackName: "blog",
      expected: [expected],
      live: [live({ image: "nginx@sha256:old@sha256:resolved", networks: ["network-id-full"] })],
      networkNamesById: { "network-id": "blog_default" },
    });
    expect(changes).toEqual([]);
  });

  it("detects replica and image edits while ignoring generated labels", () => {
    const changes = classifySwarmSpecDrift({
      stackName: "blog",
      expected: [expected],
      live: [live({ desiredReplicas: 3, image: "nginx@sha256:new" })],
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "replicas", serviceName: "web", expected: 2, actual: 3 }),
        expect.objectContaining({
          kind: "image",
          serviceName: "web",
          expected: "nginx@sha256:old",
          actual: "nginx@sha256:new",
        }),
      ]),
    );
    expect(changes.find((change) => change.kind === "labels")).toBeUndefined();
  });

  it("classifies added and removed services from service specs, not task churn", () => {
    const changes = classifySwarmSpecDrift({
      stackName: "blog",
      expected: [expected],
      live: [live({ sourceServiceName: "worker", id: "svc-worker", name: "blog_worker" })],
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "removed-service", serviceName: "web" }),
        expect.objectContaining({ kind: "added-service", serviceName: "worker" }),
      ]),
    );
  });
});
