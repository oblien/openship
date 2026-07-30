/** Safe refresh of an observe/managed stack's externally controlled live state. */

import { createHash } from "node:crypto";
import type { Platform, SwarmDiscoverySnapshot, SwarmServiceState } from "@repo/adapters";
import { AppError, NotFoundError, type SwarmServiceProjection } from "@repo/core";
import { repos, type SwarmStack, type SwarmStackRevision } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import { classifySwarmSpecDrift } from "./swarm-drift";

type SwarmPlatform = Pick<Platform, "stackRuntime">;

interface ObservationDependencies {
  featureEnabled: () => boolean;
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  getRevision: (
    revisionId: string,
    organizationId: string,
  ) => Promise<SwarmStackRevision | undefined>;
  listManaged: () => Promise<SwarmStack[]>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  updateStack: (
    id: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
  syncProjections: (projectId: string, projections: SwarmServiceProjection[]) => Promise<unknown>;
  now: () => Date;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
  );
}

function digest(services: SwarmServiceState[]): string {
  const source = services
    .map((service) => ({
      id: service.id,
      sourceServiceName: service.sourceServiceName,
      specVersion: service.specVersion,
      mode: service.mode,
      desiredReplicas: service.desiredReplicas,
      image: service.image,
      environmentKeys: service.environmentKeys,
      healthcheck: service.healthcheck,
      placement: service.placement,
      resources: service.resources,
      labels: service.labels,
      networks: service.networks,
      configs: service.configs,
      secrets: service.secrets,
      publishedPorts: service.publishedPorts,
      volumes: service.volumes,
    }))
    .sort((a, b) => a.sourceServiceName.localeCompare(b.sourceServiceName));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(source)))
    .digest("hex")}`;
}

function projection(service: SwarmServiceState, sourceDigest?: string): SwarmServiceProjection {
  return {
    sourceServiceName: service.sourceServiceName,
    observedServiceId: service.id,
    mode: service.mode,
    ...(service.desiredReplicas !== null ? { replicas: { desired: service.desiredReplicas } } : {}),
    ...(service.image ? { image: service.image } : {}),
    ...(service.environmentKeys?.length ? { environmentKeys: service.environmentKeys } : {}),
    ...(service.healthcheck ? { healthcheck: service.healthcheck } : {}),
    ...(service.endpointMode ? { endpointMode: service.endpointMode } : {}),
    ...(service.placement ? { placement: service.placement } : {}),
    ...(service.resources ? { resources: service.resources } : {}),
    ...(service.updateConfig ? { updateConfig: service.updateConfig } : {}),
    ...(service.rollbackConfig ? { rollbackConfig: service.rollbackConfig } : {}),
    ...(service.restartPolicy ? { restartPolicy: service.restartPolicy } : {}),
    labels: service.labels,
    publishedPorts: service.publishedPorts.map((port) => ({ ...port })),
    networks: service.networks,
    ...(service.volumes?.length ? { volumes: service.volumes } : {}),
    configs: service.configs,
    secrets: service.secrets,
    ...(sourceDigest ? { sourceDigest } : {}),
    sourceState: "present",
  };
}

function state(services: SwarmServiceState[]): Record<string, unknown> {
  return {
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      sourceServiceName: service.sourceServiceName,
      specVersion: service.specVersion,
      mode: service.mode,
      desiredReplicas: service.desiredReplicas,
      image: service.image,
      labels: service.labels,
      networks: service.networks,
      volumes: service.volumes,
      configs: service.configs,
      secrets: service.secrets,
    })),
  };
}

export function createSwarmObservationService(overrides: Partial<ObservationDependencies> = {}) {
  const deps: ObservationDependencies = {
    featureEnabled: swarmSupportEnabled,
    getStack: (projectId, organizationId) =>
      repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    getRevision: (revisionId, organizationId) =>
      repos.swarmStack.getRevisionInOrganization(revisionId, organizationId),
    listManaged: () => repos.swarmStack.listManaged(),
    resolvePlatform: async (serverId, organizationId) =>
      resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    updateStack: (id, organizationId, patch) =>
      repos.swarmStack.updateInOrganization(id, organizationId, patch),
    syncProjections: (projectId, projections) =>
      repos.service.syncSwarmProjections(projectId, projections),
    now: () => new Date(),
    ...overrides,
  };

  const unreachableUntil = new Map<string, number>();

  async function recordSnapshot(stack: SwarmStack, snapshot: SwarmDiscoverySnapshot) {
    const services = snapshot.services.filter((service) => service.stackName === stack.stackName);
    const current = digest(services);
    const revision =
      stack.managementMode === "managed" && stack.lastAppliedRevisionId
        ? await deps.getRevision(stack.lastAppliedRevisionId, stack.organizationId)
        : undefined;
    const expected = Array.isArray(revision?.manifest?.services)
      ? (revision.manifest.services as SwarmServiceProjection[])
      : null;
    const changes = expected
      ? classifySwarmSpecDrift({
          stackName: stack.stackName,
          expected,
          live: services,
          networkNamesById: Object.fromEntries(
            snapshot.networks.map((network) => [network.id, network.name]),
          ),
        })
      : [];
    // Observe-mode stacks have no OpenShip canonical revision to compare, so
    // retain the prior digest-only advisory until they are claimed.
    const changed = expected
      ? changes.length > 0
      : stack.lastObservedDigest !== null && stack.lastObservedDigest !== current;
    const details = changed
      ? {
          summary: expected
            ? "Live stack service specifications changed outside OpenShip."
            : "Live stack changed outside OpenShip since the previous observation.",
          serviceNames: services.map((service) => service.sourceServiceName).sort(),
          ...(changes.length ? { changes } : {}),
        }
      : {};
    await deps.updateStack(stack.id, stack.organizationId, {
      lastObservedDigest: current,
      observedState: state(services),
      lastObservedAt: deps.now(),
      driftStatus: changed ? "drifted" : "clean",
      driftDetails: details,
    });
    await deps.syncProjections(
      stack.projectId,
      services.map((service) => projection(service, revision?.renderedDigest)),
    );
    return {
      status: changed ? ("drifted" as const) : ("clean" as const),
      digest: current,
      changed,
      details,
    };
  }

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
      if (!deps.featureEnabled())
        throw new AppError(
          "Docker Swarm support is not enabled on this OpenShip instance.",
          404,
          "SWARM_FEATURE_DISABLED",
        );
      const stack = await deps.getStack(projectId, organizationId);
      if (!stack) throw new NotFoundError("Swarm stack for project", projectId);
      if (!stack.managerServerId)
        throw new AppError(
          "This stack no longer has a Swarm manager target.",
          409,
          "SWARM_MANAGER_UNAVAILABLE",
        );
      try {
        const platform = await deps.resolvePlatform(stack.managerServerId, organizationId);
        if (!platform.stackRuntime)
          throw new AppError(
            "Docker Swarm is unavailable for this target.",
            503,
            "SWARM_MANAGER_UNAVAILABLE",
          );
        const snapshot = await platform.stackRuntime.discover();
        if (snapshot.manager.clusterId !== stack.clusterId) {
          throw new AppError(
            "The configured manager now belongs to a different Swarm cluster.",
            409,
            "SWARM_CLUSTER_MISMATCH",
          );
        }
        return await recordSnapshot(stack, snapshot);
      } catch (error) {
        if (error instanceof AppError && error.code === "SWARM_CLUSTER_MISMATCH") throw error;
        await deps.updateStack(stack.id, organizationId, {
          driftStatus: "unreachable",
          driftDetails: {
            summary: "Swarm manager is unavailable; live drift could not be evaluated.",
          },
        });
        if (error instanceof AppError) throw error;
        throw new AppError(
          "Unable to refresh this Swarm stack from its manager.",
          503,
          "SWARM_MANAGER_UNAVAILABLE",
        );
      }
    },

    /**
     * Scheduler path: one manager resolution and one Engine discovery per
     * manager group, then fan the immutable snapshot out to bound stacks.
     * No provisioning lock or Docker mutation is involved.
     */
    async refreshManaged() {
      if (!deps.featureEnabled()) return { refreshed: 0, drifted: 0, unreachable: 0, deferred: 0 };
      const groups = new Map<string, SwarmStack[]>();
      for (const stack of await deps.listManaged()) {
        if (!stack.managerServerId) continue;
        const key = `${stack.organizationId}:${stack.managerServerId}`;
        groups.set(key, [...(groups.get(key) ?? []), stack]);
      }
      let refreshed = 0;
      let drifted = 0;
      let unreachable = 0;
      let deferred = 0;
      for (const [key, stacks] of groups) {
        const now = deps.now().getTime();
        if ((unreachableUntil.get(key) ?? 0) > now) {
          deferred += stacks.length;
          continue;
        }
        const managerServerId = stacks[0]!.managerServerId!;
        try {
          const platform = await deps.resolvePlatform(managerServerId, stacks[0]!.organizationId);
          if (!platform.stackRuntime) throw new Error("Swarm manager runtime unavailable");
          const snapshot = await platform.stackRuntime.discover();
          unreachableUntil.delete(key);
          for (const stack of stacks) {
            if (snapshot.manager.clusterId !== stack.clusterId) {
              await deps.updateStack(stack.id, stack.organizationId, {
                driftStatus: "drifted",
                driftDetails: {
                  summary: "The configured manager now belongs to a different Swarm cluster.",
                },
              });
              drifted++;
              continue;
            }
            const result = await recordSnapshot(stack, snapshot);
            refreshed++;
            if (result.changed) drifted++;
          }
        } catch {
          // Back off this manager group for one minute. The old successful
          // timestamp stays intact so clients can show an honestly stale view.
          unreachableUntil.set(key, now + 60_000);
          for (const stack of stacks) {
            await deps.updateStack(stack.id, stack.organizationId, {
              driftStatus: "unreachable",
              driftDetails: {
                summary: "Swarm manager is unavailable; live drift could not be evaluated.",
              },
            });
            unreachable++;
          }
        }
      }
      return { refreshed, drifted, unreachable, deferred };
    },
  };
}

export const swarmObservation = createSwarmObservationService();
