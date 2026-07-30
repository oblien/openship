/** Explicit management-ownership transitions for source-backed Swarm stacks. */

import type { Platform } from "@repo/adapters";
import { AppError, NotFoundError } from "@repo/core";
import { repos, type SwarmStack } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import { swarmLiveStateDigest } from "./swarm-preview";

type SwarmPlatform = Pick<Platform, "stackRuntime">;

interface ManagementDependencies {
  featureEnabled: () => boolean;
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  updateStack: (id: string, organizationId: string, patch: Record<string, unknown>) => Promise<SwarmStack | undefined>;
  now: () => Date;
}

export function createSwarmManagementService(overrides: Partial<ManagementDependencies> = {}) {
  const deps: ManagementDependencies = {
    featureEnabled: swarmSupportEnabled,
    getStack: (projectId, organizationId) => repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    resolvePlatform: async (serverId, organizationId) => resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    updateStack: (id, organizationId, patch) => repos.swarmStack.updateInOrganization(id, organizationId, patch),
    now: () => new Date(),
    ...overrides,
  };

  async function stackForProject(projectId: string, organizationId: string): Promise<SwarmStack> {
    if (!deps.featureEnabled()) {
      throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
    }
    const stack = await deps.getStack(projectId, organizationId);
    if (!stack) throw new NotFoundError("Swarm stack for project", projectId);
    if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");
    return stack;
  }

  return {
    /**
     * Records a one-use claim approval only. The first actual deploy verifies
     * the labels before switching to managed mode, so this read-only request
     * cannot accidentally take control of a live Portainer/CLI stack.
     */
    async claim(input: {
      projectId: string;
      organizationId: string;
      confirmedStackName: string;
      previewLiveDigest: string;
    }) {
      const stack = await stackForProject(input.projectId, input.organizationId);
      if (stack.managementMode === "managed") {
        throw new AppError("This stack is already managed by OpenShip.", 409, "SWARM_STACK_ALREADY_MANAGED");
      }
      if (input.confirmedStackName.trim() !== stack.stackName) {
        throw new AppError("Type the exact stack name to confirm management.", 400, "SWARM_STACK_CONFIRMATION_REQUIRED");
      }
      if (stack.sourceKind === "adopted" || stack.sourceStatus !== "valid") {
        throw new AppError("Link and validate authoritative stack source before claiming management.", 409, "SWARM_SOURCE_REQUIRED");
      }
      const platform = await deps.resolvePlatform(stack.managerServerId!, input.organizationId);
      if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      const snapshot = await platform.stackRuntime.discover();
      if (snapshot.manager.clusterId !== stack.clusterId) {
        throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
      }
      const live = snapshot.services.filter((service) => service.stackName === stack.stackName);
      const currentDigest = swarmLiveStateDigest(live);
      if (input.previewLiveDigest !== currentDigest) {
        throw new AppError(
          "The stack changed after preview. Refresh the live diff and confirm the current stack again.",
          409,
          "SWARM_STACK_CLAIM_STALE",
        );
      }
      const updated = await deps.updateStack(stack.id, input.organizationId, {
        // `observe` remains in force until the first apply has reconciled both
        // OpenShip labels and service IDs. claimedAt + digest authorize exactly
        // that one first write, and source replacement clears it.
        claimedAt: deps.now(),
        driftStatus: "clean",
        driftDetails: {
          claimLiveDigest: currentDigest,
          claimSourceDigest: stack.sourceDigest,
          claimReviewedAt: deps.now().toISOString(),
        },
      });
      if (!updated) throw new NotFoundError("Swarm stack", stack.id);
      return {
        stackName: stack.stackName,
        managementMode: "observe" as const,
        claimPending: true,
        liveDigest: currentDigest,
      };
    },

    /** Stop future writes without stopping or removing any Swarm resource. */
    async release(projectId: string, organizationId: string, confirmedStackName: string) {
      const stack = await stackForProject(projectId, organizationId);
      if (confirmedStackName.trim() !== stack.stackName) {
        throw new AppError("Type the exact stack name to release management.", 400, "SWARM_RELEASE_CONFIRMATION_REQUIRED");
      }
      const updated = await deps.updateStack(stack.id, organizationId, {
        managementMode: "observe",
        claimedAt: null,
        driftStatus: "unknown",
        driftDetails: { summary: "Management released by operator; OpenShip is observing this stack only." },
      });
      if (!updated) throw new NotFoundError("Swarm stack", stack.id);
      return { stackName: stack.stackName, managementMode: "observe" as const, released: true };
    },
  };
}

export const swarmManagement = createSwarmManagementService();
