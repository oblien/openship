/** Bind a new, absent stack namespace to an existing project without deploying it. */

import type { Platform } from "@repo/adapters";
import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import { assertSwarmStackName, serializeStackSource } from "./swarm-source.model";

type SwarmPlatform = Pick<Platform, "stackRuntime">;

interface BindingDependencies {
  featureEnabled: () => boolean;
  getProject: (projectId: string) => ReturnType<typeof repos.project.findById>;
  getProjectStack: (projectId: string, organizationId: string) => ReturnType<typeof repos.swarmStack.getForProjectInOrganization>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  findStack: (clusterId: string, stackName: string) => ReturnType<typeof repos.swarmStack.findByClusterName>;
  createStack: typeof repos.swarmStack.create;
  updateProject: typeof repos.project.update;
}

export function createSwarmStackBindingService(overrides: Partial<BindingDependencies> = {}) {
  const deps: BindingDependencies = {
    featureEnabled: swarmSupportEnabled,
    getProject: (projectId) => repos.project.findById(projectId),
    getProjectStack: (projectId, organizationId) => repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    resolvePlatform: async (serverId, organizationId) => resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    findStack: (clusterId, stackName) => repos.swarmStack.findByClusterName(clusterId, stackName),
    createStack: (data) => repos.swarmStack.create(data),
    updateProject: (id, patch) => repos.project.update(id, patch),
    ...overrides,
  };

  return {
    async create(input: { projectId: string; organizationId: string; serverId: string; stackName: string }) {
      if (!deps.featureEnabled()) {
        throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
      }
      const stackName = assertSwarmStackName(input.stackName);
      const project = await deps.getProject(input.projectId);
      if (!project || project.organizationId !== input.organizationId) throw new NotFoundError("Project", input.projectId);
      const existingProjectStack = await deps.getProjectStack(project.id, input.organizationId);
      if (existingProjectStack) {
        throw new AppError("This project already has a Docker Swarm stack binding.", 409, "SWARM_STACK_ALREADY_BOUND");
      }
      const platform = await deps.resolvePlatform(input.serverId, input.organizationId);
      if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      const snapshot = await platform.stackRuntime.discover();
      const liveExists = snapshot.stacks.some((stack) => stack.name === stackName) ||
        snapshot.services.some((service) => service.stackName === stackName);
      if (liveExists) {
        throw new AppError(
          "This stack already exists on the manager. Import it in observe mode before pairing source or claiming management.",
          409,
          "SWARM_STACK_ALREADY_EXISTS",
        );
      }
      const existingClusterStack = await deps.findStack(snapshot.manager.clusterId, stackName);
      if (existingClusterStack) {
        throw new AppError("This stack namespace is already bound by OpenShip.", 409, "SWARM_STACK_ALREADY_BOUND");
      }
      const binding = await deps.createStack({
        organizationId: input.organizationId,
        projectId: project.id,
        managerServerId: input.serverId,
        clusterId: snapshot.manager.clusterId,
        stackName,
        managementMode: "observe",
        sourceKind: "inline",
        sourceStatus: "missing",
        sourcePaths: [],
        sourcePath: null,
        sourceBranch: null,
        sourceCommitSha: null,
        sourceYamlEnc: null,
        sourceDigest: null,
        routingMode: "external",
        registryId: null,
        prune: false,
        resolveImage: "always",
        withRegistryAuth: false,
        lastObservedDigest: null,
        driftStatus: "unknown",
        driftDetails: {},
        observedState: {},
        lastObservedAt: null,
        claimedAt: null,
      });
      await deps.updateProject(project.id, { orchestratorMode: "swarm", runtimeMode: "docker" });
      return {
        id: binding.id,
        projectId: binding.projectId,
        managerServerId: binding.managerServerId,
        clusterId: binding.clusterId,
        stackName: binding.stackName,
        managementMode: binding.managementMode,
        source: serializeStackSource(binding),
      };
    },
  };
}

export const swarmStackBinding = createSwarmStackBindingService();
