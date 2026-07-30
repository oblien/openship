import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { createSwarmObserveService } from "./swarm-observe.service";

function snapshot(): SwarmDiscoverySnapshot {
  return {
    manager: { engineVersion: null, apiVersion: null, localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
    nodes: [],
    stacks: [{ name: "blog", serviceIds: ["service-web"], serviceNames: ["web"] }],
    services: [{
      id: "service-web", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 4,
      mode: "replicated", desiredReplicas: 2, image: "nginx@sha256:abc", labels: {}, endpointMode: null,
      placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null,
      networks: ["blog_default"], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null,
    }],
    tasks: [], networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function fixture(existing?: SwarmStack) {
  const discover = vi.fn().mockResolvedValue(snapshot());
  const createGroup = vi.fn().mockResolvedValue({ id: "app-blog" });
  const createProject = vi.fn().mockResolvedValue({ id: "proj-blog" });
  const createStack = vi.fn().mockImplementation(async (input) => ({ id: "swarm-blog", projectId: input.projectId } as unknown as SwarmStack));
  const syncProjections = vi.fn().mockResolvedValue([]);
  return {
    discover,
    createGroup,
    createProject,
    createStack,
    syncProjections,
    service: createSwarmObserveService({
      featureEnabled: () => true,
      resolvePlatform: async () => ({ stackRuntime: { discover } } as never),
      findStack: async () => existing,
      createGroup,
      createProject,
      createStack,
      syncProjections,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    }),
  };
}

describe("Swarm observe import", () => {
  it("re-discovers then creates only observe-mode records and service projections", async () => {
    const test = fixture();
    const result = await test.service.observe({ serverId: "server-a", organizationId: "org-a", stackName: "blog" });

    expect(result).toMatchObject({ projectId: "proj-blog", stackId: "swarm-blog", created: true });
    expect(result.observedDigest).toMatch(/^sha256:/);
    expect(test.discover).toHaveBeenCalledTimes(1);
    expect(test.createStack).toHaveBeenCalledWith(expect.objectContaining({
      managerServerId: "server-a", clusterId: "cluster-a", stackName: "blog", managementMode: "observe", sourceKind: "adopted",
    }));
    expect(test.syncProjections).toHaveBeenCalledWith("proj-blog", [expect.objectContaining({
      sourceServiceName: "web", observedServiceId: "service-web", sourceState: "present",
    })]);
  });

  it("is idempotent for its organization and does not create a second project", async () => {
    const test = fixture({ id: "swarm-existing", projectId: "proj-existing", organizationId: "org-a", lastObservedDigest: "sha256:old" } as unknown as SwarmStack);
    await expect(test.service.observe({ serverId: "server-a", organizationId: "org-a", stackName: "blog" })).resolves.toEqual({
      projectId: "proj-existing", stackId: "swarm-existing", created: false, observedDigest: "sha256:old",
    });
    expect(test.createProject).not.toHaveBeenCalled();
    expect(test.createStack).not.toHaveBeenCalled();
  });

  it("does not disclose or duplicate a stack already bound to another organization", async () => {
    const test = fixture({ id: "swarm-foreign", projectId: "proj-foreign", organizationId: "org-b" } as unknown as SwarmStack);
    await expect(test.service.observe({ serverId: "server-a", organizationId: "org-a", stackName: "blog" })).rejects.toMatchObject({
      statusCode: 409, code: "SWARM_STACK_ALREADY_OBSERVED",
    });
    expect(test.createGroup).not.toHaveBeenCalled();
  });
});
