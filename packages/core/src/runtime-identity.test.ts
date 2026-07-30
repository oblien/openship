import { describe, expect, it } from "vitest";
import {
  assertSupportedExecutionMatrix,
  deploymentWorkloadRef,
  isSwarmServiceRef,
  isSwarmStackRef,
  parseRuntimeServiceRef,
  parseRuntimeWorkloadRef,
  serviceWorkloadRef,
} from "./runtime-identity";

describe("runtime identity", () => {
  it("parses durable Swarm stack and service references", () => {
    const stack = parseRuntimeWorkloadRef({
      kind: "swarm-stack",
      stackName: "blog",
      clusterId: "cluster-1",
      managerServerId: "server-1",
      revisionId: "revision-1",
    });
    const service = parseRuntimeServiceRef({
      kind: "swarm-service",
      stackName: "blog",
      serviceName: "blog_web",
      serviceId: "service-1",
      clusterId: "cluster-1",
      specVersion: 4,
    });

    expect(stack.ok && isSwarmStackRef(stack.value)).toBe(true);
    expect(service.ok && isSwarmServiceRef(service.value)).toBe(true);
  });

  it("rejects incomplete Swarm identities", () => {
    expect(parseRuntimeWorkloadRef({ kind: "swarm-stack" }).ok).toBe(false);
    expect(parseRuntimeServiceRef({ kind: "swarm-service", stackName: "blog" }).ok).toBe(false);
  });

  it("keeps legacy container IDs operable without treating new Swarm refs as containers", () => {
    expect(deploymentWorkloadRef({ containerId: "abc" })).toEqual({ kind: "container", containerId: "abc" });
    expect(deploymentWorkloadRef({ containerId: "svc", meta: { runtimeMode: "bare" } })).toEqual({
      kind: "bare-process",
      processId: "svc",
    });
    expect(deploymentWorkloadRef({ containerId: "page:docs" })).toEqual({ kind: "cloud-page", pageSlug: "docs" });
    expect(
      deploymentWorkloadRef({
        runtimeRef: {
          kind: "swarm-stack",
          stackName: "blog",
          clusterId: "cluster-1",
          managerServerId: "server-1",
          revisionId: "revision-1",
        },
        containerId: "must-not-win",
      }),
    ).toEqual({
      kind: "swarm-stack",
      stackName: "blog",
      clusterId: "cluster-1",
      managerServerId: "server-1",
      revisionId: "revision-1",
    });
    expect(
      serviceWorkloadRef({
        runtimeRef: {
          kind: "swarm-service",
          stackName: "blog",
          serviceName: "blog_web",
          serviceId: "service-1",
          clusterId: "cluster-1",
          specVersion: 4,
        },
        containerId: "must-not-win",
      }),
    ).toEqual({
      kind: "swarm-service",
      stackName: "blog",
      serviceName: "blog_web",
      serviceId: "service-1",
      clusterId: "cluster-1",
      specVersion: 4,
    });
  });

  it("fails invalid execution combinations before runtime resolution", () => {
    expect(() => assertSupportedExecutionMatrix({ runtimeMode: "bare", orchestratorMode: "swarm" })).toThrow("requires runtimeMode");
    expect(() => assertSupportedExecutionMatrix({ runtimeMode: "docker", orchestratorMode: "swarm", deployTarget: "cloud" })).toThrow("cloud deployment target");
    expect(() => assertSupportedExecutionMatrix({ runtimeMode: "docker", orchestratorMode: "swarm", deployTarget: "server" })).not.toThrow();
  });
});
