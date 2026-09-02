import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { Project, SwarmStack } from "@repo/db";
import { createSwarmStackBindingService } from "./swarm-stack.service";

function snapshot(live = false): SwarmDiscoverySnapshot {
  return {
    manager: { engineVersion: null, apiVersion: null, localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
    nodes: [], stacks: live ? [{ name: "blog", serviceIds: ["svc"], serviceNames: ["web"] }] : [], services: [], tasks: [],
    networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function fixture(live = false) {
  const createStack = vi.fn(async (data: Record<string, unknown>) => ({
    id: "swarm-blog", projectId: "project-blog", managerServerId: "server-a", clusterId: "cluster-a", stackName: "blog",
    managementMode: "observe", sourceKind: "inline", sourceStatus: "missing", sourcePaths: [], sourcePath: null,
    sourceBranch: null, sourceCommitSha: null, sourceVersion: 1, sourceDigest: null, sourceYamlEnc: null,
    ...data,
  } as unknown as SwarmStack));
  const updateProject = vi.fn(async () => undefined);
  return {
    createStack,
    updateProject,
    service: createSwarmStackBindingService({
      featureEnabled: () => true,
      getProject: async () => ({ id: "project-blog", organizationId: "org-a" } as Project),
      getProjectStack: async () => undefined,
      resolvePlatform: async () => ({ stackRuntime: { discover: async () => snapshot(live) } } as never),
      findStack: async () => undefined,
      createStack: createStack as never,
      updateProject: updateProject as never,
    }),
  };
}

describe("new Swarm stack binding", () => {
  it("binds only an absent manager namespace and leaves the initial stack observe-only", async () => {
    const test = fixture();
    await expect(test.service.create({ projectId: "project-blog", organizationId: "org-a", serverId: "server-a", stackName: "blog" }))
      .resolves.toMatchObject({ stackName: "blog", managementMode: "observe", source: { status: "missing" } });
    expect(test.createStack).toHaveBeenCalledWith(expect.objectContaining({
      managerServerId: "server-a", clusterId: "cluster-a", stackName: "blog", managementMode: "observe", sourceStatus: "missing",
    }));
    expect(test.updateProject).toHaveBeenCalledWith("project-blog", { orchestratorMode: "swarm", runtimeMode: "docker" });
  });

  it("refuses to bind a stack that already exists so existing workloads must be imported first", async () => {
    const test = fixture(true);
    await expect(test.service.create({ projectId: "project-blog", organizationId: "org-a", serverId: "server-a", stackName: "blog" }))
      .rejects.toMatchObject({ code: "SWARM_STACK_ALREADY_EXISTS", statusCode: 409 });
    expect(test.createStack).not.toHaveBeenCalled();
  });
});
