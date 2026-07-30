import { describe, expect, it } from "vitest";
import { deriveSwarmServiceHealth, deriveSwarmStackHealth } from "./health";
import type { SwarmServiceState, SwarmTaskState } from "./types";

const service: SwarmServiceState = {
  id: "service-1",
  name: "blog_web",
  sourceServiceName: "web",
  stackName: "blog",
  specVersion: 2,
  mode: "replicated",
  desiredReplicas: 1,
  image: "nginx:alpine",
  loggingDriver: null,
  labels: {},
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
};
const task = (overrides: Partial<SwarmTaskState>): SwarmTaskState => ({
  id: "task-1",
  serviceId: "service-1",
  serviceName: "blog_web",
  slot: 1,
  nodeId: null,
  nodeName: null,
  desiredState: "Running",
  currentState: "Running",
  error: null,
  image: null,
  updatedAt: "2026-07-30T00:01:00.000Z",
  observedAt: "2026-07-30T00:01:00.000Z",
  ...overrides,
});

describe("Swarm service and stack health", () => {
  it("ignores an old failed task after its slot recovers", () => {
    const health = deriveSwarmServiceHealth(service, [
      task({
        id: "old",
        currentState: "Rejected",
        error: "image not found",
        updatedAt: "2026-07-30T00:00:00.000Z",
      }),
      task({ id: "current", currentState: "Running", updatedAt: "2026-07-30T00:01:00.000Z" }),
    ]);
    expect(health).toMatchObject({ state: "converged", running: 1, failed: 0 });
  });

  it("ignores old shutdown history and does not treat a completed job as stopped", () => {
    expect(
      deriveSwarmServiceHealth(service, [
        task({ id: "old", desiredState: "Shutdown", currentState: "Shutdown" }),
        task({ id: "current", currentState: "Running" }),
      ]),
    ).toMatchObject({ state: "converged", running: 1, failed: 0 });
    expect(
      deriveSwarmServiceHealth({ ...service, mode: "replicated-job", desiredReplicas: 1 }, [
        task({ desiredState: "Shutdown", currentState: "Complete" }),
      ]),
    ).toMatchObject({ state: "converged", completed: 1 });
  });

  it("reports rolling updates, scheduler rejection, global gaps, and intentional zero scale", () => {
    expect(
      deriveSwarmServiceHealth({ ...service, updateState: "updating" }, [
        task({ currentState: "Preparing" }),
      ]).state,
    ).toBe("updating");
    expect(
      deriveSwarmServiceHealth(service, [
        task({ currentState: "Rejected", error: "no suitable node" }),
      ]).state,
    ).toBe("failed");
    expect(
      deriveSwarmServiceHealth(
        { ...service, mode: "global", desiredReplicas: null },
        [task({ slot: null })],
        { eligibleNodeCount: 2 },
      ).state,
    ).toBe("degraded");
    expect(deriveSwarmServiceHealth({ ...service, desiredReplicas: 0 }, []).state).toBe(
      "scaled-to-zero",
    );
    expect(
      deriveSwarmServiceHealth({ ...service, updateState: "rollback_completed" }, [
        task({ currentState: "Running" }),
      ]).state,
    ).toBe("failed");
    expect(
      deriveSwarmServiceHealth({ ...service, mode: "replicated-job", desiredReplicas: 1 }, [
        task({ currentState: "Complete" }),
      ]).state,
    ).toBe("converged");
    expect(
      deriveSwarmServiceHealth({ ...service, mode: "replicated-job", desiredReplicas: 1 }, [
        task({ currentState: "Rejected" }),
      ]).state,
    ).toBe("failed");
  });

  it.each([
    ["a worker that is down or drained", "no suitable node (node is not available)"],
    [
      "an impossible placement constraint",
      "no suitable node (scheduling constraints not satisfied)",
    ],
    ["a missing public image", "No such image: example.invalid/app@sha256:missing"],
    [
      "private registry authentication failure",
      "pull access denied for registry.example.com/team/app",
    ],
    [
      "an unavailable registry",
      "failed to resolve reference registry.example.com/team/app: unavailable",
    ],
    ["a missing external resource", "config external-settings not found"],
    ["a failed health check", "task: non-zero exit (1)"],
  ])(
    "keeps the manager diagnostic for %s visible without inventing a recovery",
    (_scenario, error) => {
      const health = deriveSwarmServiceHealth(service, [task({ currentState: "Rejected", error })]);
      expect(health).toMatchObject({ state: "failed", failed: 1, diagnostics: [error] });
    },
  );

  it("reports a drained or lost worker as updating while a replacement is pending", () => {
    const health = deriveSwarmServiceHealth({ ...service, desiredReplicas: 2 }, [
      task({ id: "surviving", slot: 1 }),
      task({ id: "replacement", slot: 2, currentState: "Preparing" }),
    ]);
    expect(health).toMatchObject({ state: "updating", running: 1, pending: 1 });
  });

  it("distinguishes a paused update from an automatic rollback", () => {
    expect(
      deriveSwarmServiceHealth({ ...service, updateState: "paused" }, [
        task({ currentState: "Running" }),
      ]),
    ).toMatchObject({ state: "paused" });
    expect(
      deriveSwarmServiceHealth({ ...service, updateState: "rollback_completed" }, [
        task({ currentState: "Running" }),
      ]),
    ).toMatchObject({ state: "failed" });
  });

  it("derives aggregate stack states without treating manager loss as a scheduler failure", () => {
    expect(
      deriveSwarmStackHealth({
        stackName: "blog",
        services: [service],
        tasks: [task({ currentState: "Rejected" })],
      }).state,
    ).toBe("failed");
    expect(
      deriveSwarmStackHealth({
        stackName: "blog",
        services: [service],
        tasks: [],
        unreachable: true,
      }).state,
    ).toBe("unreachable");
  });
});
