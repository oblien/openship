/** Safe refresh of an observe/managed stack's externally controlled live state. */

import { createHash } from "node:crypto";
import type { Platform, SwarmServiceState } from "@repo/adapters";
import { AppError, NotFoundError, type SwarmServiceProjection } from "@repo/core";
import { repos, type SwarmStack } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";

type SwarmPlatform = Pick<Platform, "stackRuntime">;

interface ObservationDependencies {
  featureEnabled: () => boolean;
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  updateStack: (id: string, organizationId: string, patch: Record<string, unknown>) => Promise<unknown>;
  syncProjections: (projectId: string, projections: SwarmServiceProjection[]) => Promise<unknown>;
  now: () => Date;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
}

function digest(services: SwarmServiceState[]): string {
  const source = services.map((service) => ({
    id: service.id, sourceServiceName: service.sourceServiceName, specVersion: service.specVersion,
    mode: service.mode, desiredReplicas: service.desiredReplicas, image: service.image,
    placement: service.placement, resources: service.resources, labels: service.labels,
    networks: service.networks, configs: service.configs, secrets: service.secrets, publishedPorts: service.publishedPorts,
  })).sort((a, b) => a.sourceServiceName.localeCompare(b.sourceServiceName));
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(source))).digest("hex")}`;
}

function projection(service: SwarmServiceState): SwarmServiceProjection {
  return {
    sourceServiceName: service.sourceServiceName, observedServiceId: service.id, mode: service.mode,
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
    networks: service.networks, configs: service.configs, secrets: service.secrets, sourceState: "present",
  };
}

function state(services: SwarmServiceState[]): Record<string, unknown> {
  return { services: services.map((service) => ({
    id: service.id, name: service.name, sourceServiceName: service.sourceServiceName, specVersion: service.specVersion,
    mode: service.mode, desiredReplicas: service.desiredReplicas, image: service.image,
    labels: service.labels, networks: service.networks, configs: service.configs, secrets: service.secrets,
  })) };
}

export function createSwarmObservationService(overrides: Partial<ObservationDependencies> = {}) {
  const deps: ObservationDependencies = {
    featureEnabled: swarmSupportEnabled,
    getStack: (projectId, organizationId) => repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    resolvePlatform: async (serverId, organizationId) => resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    updateStack: (id, organizationId, patch) => repos.swarmStack.updateInOrganization(id, organizationId, patch),
    syncProjections: (projectId, projections) => repos.service.syncSwarmProjections(projectId, projections),
    now: () => new Date(),
    ...overrides,
  };

  return {
    async status(projectId: string, organizationId: string) {
      const stack = await deps.getStack(projectId, organizationId);
      if (!stack) throw new NotFoundError("Swarm stack for project", projectId);
      return {
        // These identifiers are metadata for the dashboard's read-only detail
        // views. They are deliberately returned with the observation rather
        // than inferred from a deployment: observed stacks do not create one.
        stackName: stack.stackName,
        managerServerId: stack.managerServerId,
        clusterId: stack.clusterId,
        managementMode: stack.managementMode,
        source: {
          kind: stack.sourceKind,
          status: stack.sourceStatus,
          deployable: stack.sourceStatus === "valid",
        },
        drift: {
          status: stack.driftStatus,
          details: stack.driftDetails,
          lastObservedAt: stack.lastObservedAt,
          digest: stack.lastObservedDigest,
        },
      };
    },

    async refresh(projectId: string, organizationId: string) {
      if (!deps.featureEnabled()) throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
      const stack = await deps.getStack(projectId, organizationId);
      if (!stack) throw new NotFoundError("Swarm stack for project", projectId);
      if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");
      try {
        const platform = await deps.resolvePlatform(stack.managerServerId, organizationId);
        if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
        const snapshot = await platform.stackRuntime.discover();
        if (snapshot.manager.clusterId !== stack.clusterId) {
          throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
        }
        const services = snapshot.services.filter((service) => service.stackName === stack.stackName);
        const current = digest(services);
        const changed = stack.lastObservedDigest !== null && stack.lastObservedDigest !== current;
        const details = changed
          ? { summary: "Live stack changed outside OpenShip since the previous observation.", serviceNames: services.map((service) => service.sourceServiceName).sort() }
          : {};
        await deps.updateStack(stack.id, organizationId, {
          lastObservedDigest: current,
          observedState: state(services),
          lastObservedAt: deps.now(),
          driftStatus: changed ? "drifted" : "clean",
          driftDetails: details,
        });
        await deps.syncProjections(projectId, services.map(projection));
        return { status: changed ? "drifted" as const : "clean" as const, digest: current, changed, details };
      } catch (error) {
        if (error instanceof AppError && error.code === "SWARM_CLUSTER_MISMATCH") throw error;
        await deps.updateStack(stack.id, organizationId, {
          driftStatus: "unreachable",
          driftDetails: { summary: "Swarm manager is unavailable; live drift could not be evaluated." },
        });
        if (error instanceof AppError) throw error;
        throw new AppError("Unable to refresh this Swarm stack from its manager.", 503, "SWARM_MANAGER_UNAVAILABLE");
      }
    },
  };
}

export const swarmObservation = createSwarmObservationService();
