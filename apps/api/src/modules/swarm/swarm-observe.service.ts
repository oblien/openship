/** Import a live Swarm stack into an explicitly non-mutating OpenShip binding. */

import { createHash } from "node:crypto";
import type { Platform, SwarmDiscoverySnapshot, SwarmServiceState } from "@repo/adapters";
import { AppError, slugify, type SwarmServiceProjection } from "@repo/core";
import { repos, type SwarmStack } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";

type SwarmPlatform = Pick<Platform, "stackRuntime">;

interface ObserveDependencies {
  featureEnabled: () => boolean;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  findStack: (clusterId: string, stackName: string) => Promise<SwarmStack | undefined>;
  createGroup: (input: { organizationId: string; name: string; slug: string }) => Promise<{ id: string }>;
  createProject: (input: {
    organizationId: string; groupId: string; name: string; slug: string;
    runtimeMode: "docker"; orchestratorMode: "swarm";
  }) => Promise<{ id: string }>;
  createStack: (input: {
    organizationId: string; projectId: string; managerServerId: string; clusterId: string; stackName: string;
    managementMode: "observe"; sourceKind: "adopted"; sourcePaths: string[]; sourcePath: null; sourceYamlEnc: null;
    sourceStatus: "missing";
    sourceDigest: null; lastObservedDigest: string; observedState: Record<string, unknown>; lastObservedAt: Date;
  }) => Promise<SwarmStack>;
  syncProjections: (projectId: string, projections: SwarmServiceProjection[]) => Promise<unknown>;
  now: () => Date;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
}

function observedDigest(services: SwarmServiceState[]): string {
  const summary = services.map((service) => ({
    id: service.id, sourceServiceName: service.sourceServiceName, specVersion: service.specVersion,
    mode: service.mode, desiredReplicas: service.desiredReplicas, image: service.image,
    placement: service.placement, resources: service.resources, labels: service.labels,
    networks: service.networks, configs: service.configs, secrets: service.secrets, publishedPorts: service.publishedPorts,
  })).sort((a, b) => a.sourceServiceName.localeCompare(b.sourceServiceName));
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(summary))).digest("hex")}`;
}

function observedState(services: SwarmServiceState[]): Record<string, unknown> {
  return {
    services: services.map((service) => ({
      id: service.id, name: service.name, sourceServiceName: service.sourceServiceName, specVersion: service.specVersion,
      mode: service.mode, desiredReplicas: service.desiredReplicas, image: service.image,
      labels: service.labels, networks: service.networks, configs: service.configs, secrets: service.secrets,
    })),
  };
}

function projection(service: SwarmServiceState): SwarmServiceProjection {
  return {
    sourceServiceName: service.sourceServiceName,
    observedServiceId: service.id,
    mode: service.mode,
    ...(service.desiredReplicas !== null ? { replicas: { desired: service.desiredReplicas } } : {}),
    ...(service.image ? { image: service.image } : {}),
    ...(service.endpointMode ? { endpointMode: service.endpointMode } : {}),
    ...(service.placement ? { placement: service.placement } : {}),
    ...(service.resources ? { resources: service.resources } : {}),
    ...(service.updateConfig ? { updateConfig: service.updateConfig } : {}),
    ...(service.rollbackConfig ? { rollbackConfig: service.rollbackConfig } : {}),
    ...(service.restartPolicy ? { restartPolicy: service.restartPolicy } : {}),
    labels: service.labels,
    publishedPorts: service.publishedPorts.map((port) => ({ ...port })),
    networks: service.networks,
    configs: service.configs,
    secrets: service.secrets,
    sourceState: "present",
  };
}

function importSlug(stackName: string, clusterId: string): string {
  return `swarm-${slugify(stackName) || "stack"}-${clusterId.slice(0, 8).toLowerCase()}`.slice(0, 96);
}

export function createSwarmObserveService(overrides: Partial<ObserveDependencies> = {}) {
  const deps: ObserveDependencies = {
    featureEnabled: swarmSupportEnabled,
    resolvePlatform: async (serverId, organizationId) => resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    findStack: (clusterId, stackName) => repos.swarmStack.findByClusterName(clusterId, stackName),
    createGroup: async (input) => repos.projectGroup.create({ ...input, gitProvider: "local" }),
    createProject: async (input) => repos.project.create({
      ...input,
      environmentName: "Production",
      environmentSlug: "production",
      environmentType: "production",
      gitProvider: "local",
      framework: "unknown",
      packageManager: "npm",
      hasServer: true,
      hasBuild: false,
    }),
    createStack: (input) => repos.swarmStack.create({ ...input, routingMode: "external", prune: false, resolveImage: "changed", withRegistryAuth: false }),
    syncProjections: (projectId, projections) => repos.service.syncSwarmProjections(projectId, projections),
    now: () => new Date(),
    ...overrides,
  };

  return {
    async observe(input: { serverId: string; organizationId: string; stackName: string }) {
      if (!deps.featureEnabled()) throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
      const platform = await deps.resolvePlatform(input.serverId, input.organizationId);
      if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      // Do not use the short polling cache: import must make its decision from
      // the manager's truth at execution time.
      const snapshot = await platform.stackRuntime.discover();
      const stack = snapshot.stacks.find((candidate) => candidate.name === input.stackName);
      if (!stack) throw new AppError("Swarm stack not found on this manager.", 404, "SWARM_STACK_NOT_FOUND");
      const services = snapshot.services.filter((service) => service.stackName === input.stackName);
      const existing = await deps.findStack(snapshot.manager.clusterId, input.stackName);
      if (existing) {
        if (existing.organizationId !== input.organizationId) {
          throw new AppError("This live Swarm stack is already observed by another organization.", 409, "SWARM_STACK_ALREADY_OBSERVED");
        }
        return { projectId: existing.projectId, stackId: existing.id, created: false, observedDigest: existing.lastObservedDigest };
      }

      const slug = importSlug(input.stackName, snapshot.manager.clusterId);
      const group = await deps.createGroup({ organizationId: input.organizationId, name: input.stackName, slug });
      const project = await deps.createProject({
        organizationId: input.organizationId, groupId: group.id, name: input.stackName, slug,
        runtimeMode: "docker", orchestratorMode: "swarm",
      });
      const digest = observedDigest(services);
      const binding = await deps.createStack({
        organizationId: input.organizationId,
        projectId: project.id,
        managerServerId: input.serverId,
        clusterId: snapshot.manager.clusterId,
        stackName: input.stackName,
        managementMode: "observe",
        sourceKind: "adopted",
        sourceStatus: "missing",
        sourcePaths: [],
        sourcePath: null,
        sourceYamlEnc: null,
        sourceDigest: null,
        lastObservedDigest: digest,
        observedState: observedState(services),
        lastObservedAt: deps.now(),
      });
      await deps.syncProjections(project.id, services.map(projection));
      return { projectId: project.id, stackId: binding.id, created: true, observedDigest: digest };
    },
  };
}

export const swarmObserve = createSwarmObserveService();
