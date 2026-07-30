import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { swarmLiveStateDigest } from "./swarm-preview";
import { createSwarmManagementService } from "./swarm-management.service";

const stack = {
  id: "swarm-blog", projectId: "project-blog", organizationId: "org-a", managerServerId: "server-a", clusterId: "cluster-a",
  stackName: "blog", managementMode: "observe", claimedAt: null, sourceKind: "inline", sourceStatus: "valid", sourceVersion: 4, sourceDigest: "sha256:source",
  driftDetails: {},
} as unknown as SwarmStack;

const snapshot: SwarmDiscoverySnapshot = {
  manager: { engineVersion: null, apiVersion: null, localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
  nodes: [], stacks: [{ name: "blog", serviceIds: ["service-web"], serviceNames: ["web"] }],
  services: [{ id: "service-web", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 1, mode: "replicated", desiredReplicas: 1, image: "nginx:1.27-alpine", loggingDriver: null, labels: {}, endpointMode: null, placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null, networks: [], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null }],
  tasks: [], networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
};

function fixture() {
  const updateStack = vi.fn(async () => stack);
  return {
    updateStack,
    service: createSwarmManagementService({
      featureEnabled: () => true,
      getStack: async () => stack,
      resolvePlatform: async () => ({ stackRuntime: { discover: async () => snapshot } } as never),
      updateStack,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    }),
  };
}

describe("Swarm management ownership", () => {
  it("requires the exact stack name and current preview digest before a first-write claim", async () => {
    const test = fixture();
    await expect(test.service.claim({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", previewLiveDigest: "sha256:0".padEnd(71, "0"), expectedSourceVersion: 4,
    })).rejects.toMatchObject({ code: "SWARM_STACK_CLAIM_STALE", statusCode: 409 });
    expect(test.updateStack).not.toHaveBeenCalled();
  });

  it("records a one-use claim without changing management mode or touching Docker", async () => {
    const test = fixture();
    const digest = swarmLiveStateDigest(snapshot.services);
    await expect(test.service.claim({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", previewLiveDigest: digest, expectedSourceVersion: 4,
    })).resolves.toEqual({ stackName: "blog", managementMode: "observe", claimPending: true, liveDigest: digest });
    expect(test.updateStack).toHaveBeenCalledWith("swarm-blog", "org-a", expect.objectContaining({
      claimedAt: expect.any(Date),
      driftDetails: expect.objectContaining({ claimLiveDigest: digest, claimSourceDigest: "sha256:source" }),
    }));
  });

  it("releases management without contacting or stopping the stack", async () => {
    const test = fixture();
    await expect(test.service.release("project-blog", "org-a", "blog", 4))
      .resolves.toEqual({ stackName: "blog", managementMode: "observe", released: true });
    expect(test.updateStack).toHaveBeenCalledWith("swarm-blog", "org-a", expect.objectContaining({
      managementMode: "observe", claimedAt: null,
    }));
  });

  it("requires an exact name before releasing management", async () => {
    const test = fixture();
    await expect(test.service.release("project-blog", "org-a", "Blog", 4))
      .rejects.toMatchObject({ code: "SWARM_RELEASE_CONFIRMATION_REQUIRED", statusCode: 400 });
    expect(test.updateStack).not.toHaveBeenCalled();
  });

  it("rejects a stale source version before claim or release changes ownership", async () => {
    const test = fixture();
    const digest = swarmLiveStateDigest(snapshot.services);
    await expect(test.service.claim({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", previewLiveDigest: digest, expectedSourceVersion: 3,
    })).rejects.toMatchObject({ code: "SWARM_STACK_CONFIRMATION_STALE", statusCode: 409 });
    await expect(test.service.release("project-blog", "org-a", "blog", 3))
      .rejects.toMatchObject({ code: "SWARM_RELEASE_CONFIRMATION_STALE", statusCode: 409 });
    expect(test.updateStack).not.toHaveBeenCalled();
  });
});
