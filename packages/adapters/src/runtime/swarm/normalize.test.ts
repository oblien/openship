import { describe, expect, it } from "vitest";
import {
  groupSwarmStacks,
  normalizeSwarmNamedObject,
  normalizeSwarmService,
  normalizeSwarmTask,
} from "./normalize";

describe("Swarm discovery normalizers", () => {
  it("preserves service deployment metadata while deriving a source service name", () => {
    const service = normalizeSwarmService({
      ID: "service-1",
      Version: { Index: 8 },
      Spec: {
        Name: "blog_web",
        Labels: { "com.docker.stack.namespace": "blog", team: "web" },
        Mode: { Replicated: { Replicas: 3 } },
        EndpointSpec: { Mode: "vip", Ports: [{ TargetPort: 3000, PublishedPort: 80, Protocol: "tcp", PublishMode: "ingress" }] },
        TaskTemplate: {
          ContainerSpec: {
            Image: "registry.test/blog@sha256:abc",
            Configs: [{ ConfigName: "blog_config" }],
            Secrets: [{ SecretName: "blog_password", File: { Name: "password" } }],
          },
          Placement: { Constraints: ["node.role == worker"] },
          Resources: { Limits: { NanoCPUs: 500_000_000 } },
          RestartPolicy: { Condition: "on-failure" },
          Networks: [{ Target: "network-1" }],
        },
        UpdateConfig: { Parallelism: 1 },
        RollbackConfig: { Parallelism: 1 },
      },
      Endpoint: { Ports: [{ TargetPort: 3000, PublishedPort: 80, Protocol: "tcp", PublishMode: "ingress" }] },
      UpdateStatus: { State: "updating", Message: "rolling" },
    });

    expect(service).toMatchObject({
      id: "service-1",
      sourceServiceName: "web",
      stackName: "blog",
      mode: "replicated",
      desiredReplicas: 3,
      configs: ["blog_config"],
      secrets: ["blog_password"],
      publishedPorts: [{ target: 3000, published: 80 }],
    });
    expect(groupSwarmStacks([service])).toEqual([
      { name: "blog", serviceIds: ["service-1"], serviceNames: ["web"] },
    ]);
  });

  it("keeps historical task rows for the health selector and never reads named-object payloads", () => {
    const task = normalizeSwarmTask(
      { ID: "task-1", Name: "blog_web.2", Node: "worker-1", DesiredState: "Running", CurrentState: "Running 4 seconds ago" },
      { id: "service-1", name: "blog_web" },
      "2026-07-30T00:00:00.000Z",
    );
    expect(task).toMatchObject({ serviceId: "service-1", slot: 2, nodeName: "worker-1" });
    expect(normalizeSwarmNamedObject({ ID: "secret-1", Name: "db_password", Data: "must-not-leak" })).toEqual({
      id: "secret-1",
      name: "db_password",
      labels: {},
      createdAt: null,
    });
  });
});
