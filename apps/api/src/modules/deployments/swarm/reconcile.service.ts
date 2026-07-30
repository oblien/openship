/** Recover an accepted-or-unknown Swarm apply by reading the manager only. */

import {
  deriveSwarmStackHealth,
  type Platform,
  type SwarmDiscoverySnapshot,
  type SwarmServiceState,
} from "@repo/adapters";
import type { RuntimeServiceRef, SwarmServiceProjection } from "@repo/core";
import {
  repos,
  type Deployment,
  type Project,
  type Service,
  type ServiceDeployment,
  type SwarmStack,
  type SwarmStackRevision,
} from "@repo/db";
import { resolveTargetPlatform } from "../../../lib/deployment-runtime";
import { isConnectionLoss } from "../../../lib/remote-state";
import { swarmLiveStateDigest } from "../../swarm/swarm-preview";
import { classifySwarmSpecDrift } from "../../swarm/swarm-drift";

type SwarmPlatform = Pick<Platform, "stackRuntime">;
type SwarmRuntimeServiceRef = Extract<RuntimeServiceRef, { kind: "swarm-service" }>;
export type SwarmReconcileOutcome = "finalized" | "unreachable" | "pending";

interface Dependencies {
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  getRevision: (
    revisionId: string,
    organizationId: string,
  ) => Promise<SwarmStackRevision | undefined>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  updateRevision: (
    revisionId: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
  updateStack: (
    id: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
  syncProjections: (projectId: string, projections: SwarmServiceProjection[]) => Promise<Service[]>;
  listServiceDeployments: (deploymentId: string) => Promise<ServiceDeployment[]>;
  updateServiceDeployment: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  createServiceDeployments: (
    rows: Array<{
      deploymentId: string;
      serviceId: string;
      serviceName: string;
      runtimeRef: SwarmRuntimeServiceRef;
      status: "success" | "failure";
      imageRef: string | null;
      startedAt: Date;
      finishedAt: Date;
    }>,
  ) => Promise<unknown>;
  updateDeployment: (
    id: string,
    status: string,
    patch?: Record<string, unknown>,
  ) => Promise<unknown>;
  getProject: (id: string) => Promise<Project | undefined>;
  getDeployment: (id: string) => Promise<Deployment | undefined>;
  setActiveDeployment: (projectId: string, deploymentId: string) => Promise<unknown>;
  retainDeployment: (newDeployment: Deployment, previousActive: Deployment | null) => Promise<void>;
  now: () => Date;
}

function ownershipLabels(stack: SwarmStack): Record<string, string> {
  return { "com.openship.stack-id": stack.id, "com.openship.project-id": stack.projectId };
}

function isOwned(service: SwarmServiceState, stack: SwarmStack): boolean {
  return Object.entries(ownershipLabels(stack)).every(
    ([key, value]) => service.labels[key] === value,
  );
}

function projection(service: SwarmServiceState, sourceDigest: string): SwarmServiceProjection {
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
    sourceDigest,
    sourceState: "present",
  };
}

function serviceRefs(
  stack: SwarmStack,
  services: SwarmServiceState[],
): Record<string, SwarmRuntimeServiceRef> {
  return Object.fromEntries(
    services.map((service) => [
      service.sourceServiceName,
      {
        kind: "swarm-service" as const,
        clusterId: stack.clusterId,
        stackName: stack.stackName,
        serviceId: service.id,
        serviceName: service.sourceServiceName,
        specVersion: service.specVersion ?? 0,
      },
    ]),
  );
}

function observedState(services: SwarmServiceState[]): Record<string, unknown> {
  return {
    services: services.map((service) => ({
      id: service.id,
      sourceServiceName: service.sourceServiceName,
      specVersion: service.specVersion,
      mode: service.mode,
      desiredReplicas: service.desiredReplicas,
      image: service.image,
      environmentKeys: service.environmentKeys,
      labels: service.labels,
      networks: service.networks,
      volumes: service.volumes,
      configs: service.configs,
      secrets: service.secrets,
    })),
  };
}

function metaWithOutcome(
  dep: Deployment,
  outcome: Record<string, unknown>,
): Record<string, unknown> {
  const meta =
    dep.meta && typeof dep.meta === "object" && !Array.isArray(dep.meta)
      ? (dep.meta as Record<string, unknown>)
      : {};
  return { ...meta, swarmDeployment: outcome };
}

function expectedServices(revision: SwarmStackRevision): SwarmServiceProjection[] | null {
  const services = revision.manifest?.services;
  return Array.isArray(services) ? (services as SwarmServiceProjection[]) : null;
}

/** The factory makes failure/restart recovery executable without Docker. */
export function createSwarmDeploymentReconciler(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    getStack: (projectId, organizationId) =>
      repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    getRevision: (revisionId, organizationId) =>
      repos.swarmStack.getRevisionInOrganization(revisionId, organizationId),
    resolvePlatform: async (serverId, organizationId) =>
      resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    updateRevision: (revisionId, organizationId, patch) =>
      repos.swarmStack.updateRevisionInOrganization(revisionId, organizationId, patch),
    updateStack: (id, organizationId, patch) =>
      repos.swarmStack.updateInOrganization(id, organizationId, patch),
    syncProjections: (projectId, projections) =>
      repos.service.syncSwarmProjections(projectId, projections),
    listServiceDeployments: (deploymentId) =>
      repos.serviceDeployment.listByDeployment(deploymentId),
    updateServiceDeployment: (id, patch) => repos.serviceDeployment.update(id, patch),
    createServiceDeployments: (rows) => repos.serviceDeployment.bulkCreate(rows),
    updateDeployment: (id, status, patch) => repos.deployment.updateStatus(id, status, patch),
    getProject: (id) => repos.project.findById(id),
    getDeployment: (id) => repos.deployment.findById(id),
    setActiveDeployment: (projectId, deploymentId) =>
      repos.project.setActiveDeployment(projectId, deploymentId),
    retainDeployment: async (newDeployment, previousActive) => {
      const { onDeploymentReady } = await import("../rollback");
      await onDeploymentReady({ newDeployment, previousActive });
    },
    now: () => new Date(),
    ...overrides,
  };

  async function advanceProject(dep: Deployment): Promise<Deployment | null> {
    const project = await deps.getProject(dep.projectId);
    if (!project) return null;
    const active = project.activeDeploymentId
      ? await deps.getDeployment(project.activeDeploymentId)
      : undefined;
    if (!active || active.id === dep.id || active.createdAt.getTime() < dep.createdAt.getTime()) {
      await deps.setActiveDeployment(project.id, dep.id);
      return active ?? null;
    }
    return null;
  }

  return {
    async reconcile(input: {
      deployment: Deployment;
      runtimeRef: {
        kind: "swarm-stack";
        clusterId: string;
        managerServerId: string;
        stackName: string;
        revisionId: string;
      };
    }): Promise<SwarmReconcileOutcome> {
      const { deployment, runtimeRef } = input;
      const stack = await deps.getStack(deployment.projectId, deployment.organizationId);
      const revision = await deps.getRevision(runtimeRef.revisionId, deployment.organizationId);
      const expected = revision ? expectedServices(revision) : null;
      if (
        !stack ||
        !revision ||
        !expected ||
        revision.stackId !== stack.id ||
        stack.clusterId !== runtimeRef.clusterId ||
        stack.managerServerId !== runtimeRef.managerServerId ||
        stack.stackName !== runtimeRef.stackName
      ) {
        await deps.updateDeployment(deployment.id, "failed", {
          errorMessage:
            "Swarm reconciliation could not verify the original stack binding and revision.",
          meta: metaWithOutcome(deployment, {
            state: "failed",
            reason: "binding-or-revision-missing",
          }),
        });
        return "finalized";
      }

      let snapshot: SwarmDiscoverySnapshot;
      try {
        const platform = await deps.resolvePlatform(
          stack.managerServerId!,
          deployment.organizationId,
        );
        if (!platform.stackRuntime) throw new Error("Swarm manager runtime unavailable");
        snapshot = await platform.stackRuntime.discover();
      } catch (error) {
        if (isConnectionLoss(error) || error instanceof Error) return "unreachable";
        throw error;
      }
      if (snapshot.manager.clusterId !== stack.clusterId) {
        await deps.updateStack(stack.id, deployment.organizationId, {
          driftStatus: "drifted",
          driftDetails: {
            summary: "The configured manager now belongs to a different Swarm cluster.",
          },
        });
        await deps.updateDeployment(deployment.id, "partial_failure", {
          errorMessage: "The configured Swarm manager now belongs to a different cluster.",
          meta: metaWithOutcome(deployment, { state: "drifted", reason: "cluster-mismatch" }),
        });
        return "finalized";
      }

      const live = snapshot.services.filter((service) => service.stackName === stack.stackName);
      const changes = classifySwarmSpecDrift({
        stackName: stack.stackName,
        expected,
        live,
        networkNamesById: Object.fromEntries(
          snapshot.networks.map((network) => [network.id, network.name]),
        ),
      });
      const unowned = live
        .filter((service) => !isOwned(service, stack))
        .map((service) => service.sourceServiceName);
      if (changes.length > 0 || unowned.length > 0) {
        const details = {
          summary: "The live managed stack differs from the revision OpenShip was reconciling.",
          changes,
          ...(unowned.length ? { unownedServices: unowned } : {}),
        };
        await deps.updateStack(stack.id, deployment.organizationId, {
          driftStatus: "drifted",
          driftDetails: details,
          lastObservedDigest: swarmLiveStateDigest(live),
          lastObservedAt: deps.now(),
          observedState: observedState(live),
        });
        await deps.updateRevision(revision.id, deployment.organizationId, {
          applyStatus: "partial",
          applyOutput: { ...revision.applyOutput, reconciliation: details },
        });
        await deps.updateDeployment(deployment.id, "partial_failure", {
          errorMessage:
            "The stack changed outside OpenShip before its deployment outcome could be verified.",
          meta: metaWithOutcome(deployment, { state: "drifted", ...details }),
        });
        return "finalized";
      }

      const health = deriveSwarmStackHealth({
        stackName: stack.stackName,
        services: live,
        tasks: snapshot.tasks,
        eligibleNodeCount: snapshot.nodes.filter(
          (node) =>
            node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active",
        ).length,
      });
      if (health.state === "deploying" || health.state === "reconciling") {
        await deps.updateRevision(revision.id, deployment.organizationId, {
          applyStatus: "converging",
          applyOutput: { ...revision.applyOutput, health, reconciliation: { state: "pending" } },
        });
        return "pending";
      }

      const refs = serviceRefs(stack, live);
      const projected = await deps.syncProjections(
        deployment.projectId,
        live.map((service) => projection(service, revision.renderedDigest)),
      );
      const existing = new Map(
        (await deps.listServiceDeployments(deployment.id)).map((row) => [row.serviceName, row]),
      );
      const finishedAt = deps.now();
      const serviceHealth = new Map(health.services.map((service) => [service.serviceId, service]));
      const additions: Array<Parameters<Dependencies["createServiceDeployments"]>[0][number]> = [];
      for (const service of projected) {
        const ref = refs[service.name];
        if (!ref) continue;
        const current = existing.get(service.name);
        const itemHealth = serviceHealth.get(ref.serviceId);
        const status: "success" | "failure" =
          itemHealth?.state === "converged" || itemHealth?.state === "scaled-to-zero"
            ? "success"
            : "failure";
        const patch = {
          runtimeRef: ref,
          status,
          imageRef: live.find((item) => item.id === ref.serviceId)?.image ?? null,
          finishedAt,
        };
        if (current) await deps.updateServiceDeployment(current.id, patch);
        else
          additions.push({
            deploymentId: deployment.id,
            serviceId: service.id,
            serviceName: service.name,
            ...patch,
            startedAt: deployment.createdAt,
          });
      }
      if (additions.length) await deps.createServiceDeployments(additions);

      const terminal =
        health.state === "ready"
          ? "ready"
          : health.state === "failed"
            ? "failed"
            : "partial_failure";
      await deps.updateRevision(revision.id, deployment.organizationId, {
        applyStatus: terminal === "ready" ? "ready" : terminal === "failed" ? "failed" : "partial",
        applyOutput: { ...revision.applyOutput, health, reconciliation: { state: terminal } },
        serviceRefs: refs,
        ...(terminal === "ready" ? { convergedAt: finishedAt } : {}),
      });
      await deps.updateStack(stack.id, deployment.organizationId, {
        managementMode: "managed",
        sourceStatus: "valid",
        lastAppliedRevisionId: revision.id,
        lastObservedDigest: swarmLiveStateDigest(live),
        lastObservedAt: finishedAt,
        observedState: observedState(live),
        driftStatus: terminal === "ready" ? "clean" : "unknown",
        driftDetails:
          terminal === "ready"
            ? {}
            : { summary: "Swarm reconciliation found unhealthy services.", health },
      });
      await deps.updateDeployment(deployment.id, terminal, {
        errorMessage:
          terminal === "ready"
            ? null
            : health.diagnostics.join("; ") || "Swarm services did not reach a healthy state.",
        meta: metaWithOutcome(deployment, { state: terminal, health }),
      });
      if (terminal !== "failed") {
        const previousActive = await advanceProject(deployment);
        try {
          await deps.retainDeployment(deployment, previousActive);
        } catch (error) {
          console.error(`[swarm-reconcile] Failed to retain deployment ${deployment.id}:`, error);
        }
      }
      return "finalized";
    },
  };
}

export const swarmDeploymentReconciler = createSwarmDeploymentReconciler();
