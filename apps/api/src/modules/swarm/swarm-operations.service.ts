/** Managed, scheduler-level Swarm operations. Never address task containers. */

import { parseDocument } from "yaml";
import {
  deriveSwarmStackHealth,
  type Platform,
  type StackRuntimeAdapter,
  type SwarmServiceLogEntry,
  type SwarmServiceState,
} from "@repo/adapters";
import { AppError, NotFoundError } from "@repo/core";
import { repos, type Project, type SwarmStack } from "@repo/db";
import { swarmSupportEnabled } from "../../config";
import { decryptSecretField, encryptSecretField } from "../../lib/credential-encryption";
import { resolveTargetPlatform } from "../../lib/deployment-runtime";
import { isConnectionLoss } from "../../lib/remote-state";
import { swarmConvergence } from "../deployments/swarm/convergence.service";
import { validateStackSource } from "./swarm-source.model";
import { swarmObservation } from "./swarm-observation.service";

type SwarmPlatform = Pick<Platform, "stackRuntime">;
export type ScalePersistence = "temporary" | "inline-source";

interface Dependencies {
  featureEnabled: () => boolean;
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  waitForConvergence: typeof swarmConvergence.wait;
  refresh: (projectId: string, organizationId: string) => Promise<unknown>;
  updateSource: (
    stack: SwarmStack,
    source: ReturnType<typeof validateStackSource>,
  ) => Promise<SwarmStack | undefined>;
  updateStack: (id: string, organizationId: string, patch: Record<string, unknown>) => Promise<unknown>;
  getProject: (projectId: string) => Promise<Project | undefined>;
  updateDeploymentStatus: (deploymentId: string, status: string, patch: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

function ownershipLabels(stack: SwarmStack): Record<string, string> {
  return {
    "com.openship.stack-id": stack.id,
    "com.openship.project-id": stack.projectId,
  };
}

function isOwned(service: SwarmServiceState, stack: SwarmStack): boolean {
  return Object.entries(ownershipLabels(stack)).every(([key, value]) => service.labels[key] === value);
}

function stackOwnedPersistentObjects(
  snapshot: Awaited<ReturnType<StackRuntimeAdapter["discover"]>>,
  stack: SwarmStack,
): string[] {
  const inStack = (labels: Record<string, string>) => labels["com.docker.stack.namespace"] === stack.stackName;
  return [
    ...snapshot.configs.filter((config) => inStack(config.labels)).map((config) => `config/${config.name}`),
    ...snapshot.secrets.filter((secret) => inStack(secret.labels)).map((secret) => `secret/${secret.name}`),
  ].sort();
}

function scaleSourceYaml(stack: SwarmStack, serviceName: string, replicas: number) {
  if (stack.sourceKind !== "inline") {
    throw new AppError(
      "Keeping this scale in source is available only for an authoritative inline stack document. This operation can still be applied as a temporary override.",
      409,
      "SWARM_SCALE_SOURCE_UNAVAILABLE",
    );
  }
  const yaml = decryptSecretField(stack.sourceYamlEnc);
  if (!yaml) throw new AppError("This stack has no authoritative inline source document.", 409, "SWARM_SOURCE_REQUIRED");
  const document = parseDocument(yaml, { prettyErrors: false });
  if (document.errors.length || !document.hasIn(["services", serviceName])) {
    throw new AppError("The authoritative stack source no longer defines this service.", 409, "SWARM_SCALE_SOURCE_STALE");
  }
  document.setIn(["services", serviceName, "deploy", "replicas"], replicas);
  return validateStackSource({ kind: "inline", yaml: String(document), expectedVersion: stack.sourceVersion });
}

const NON_READABLE_LOG_DRIVERS = new Set([
  "none",
  "syslog",
  "gelf",
  "fluentd",
  "splunk",
  "awslogs",
]);

function sensitiveEnvironmentValues(stack: SwarmStack): string[] {
  if (stack.sourceKind !== "inline") return [];
  const yaml = decryptSecretField(stack.sourceYamlEnc);
  if (!yaml) return [];
  try {
    const document = parseDocument(yaml, { prettyErrors: false });
    if (document.errors.length) return [];
    const root = document.toJS() as { services?: Record<string, { environment?: unknown }> } | null;
    const values = new Set<string>();
    for (const service of Object.values(root?.services ?? {})) {
      const environment = service?.environment;
      if (Array.isArray(environment)) {
        for (const entry of environment) {
          if (typeof entry !== "string") continue;
          const separator = entry.indexOf("=");
          const key = separator >= 0 ? entry.slice(0, separator) : "";
          const value = separator >= 0 ? entry.slice(separator + 1) : "";
          if (isSensitiveEnvironmentKey(key) && isRedactableLiteral(value)) values.add(value);
        }
      } else if (environment && typeof environment === "object") {
        for (const [key, value] of Object.entries(environment)) {
          if (isSensitiveEnvironmentKey(key) && typeof value === "string" && isRedactableLiteral(value)) {
            values.add(value);
          }
        }
      }
    }
    return [...values].sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

function isSensitiveEnvironmentKey(value: string): boolean {
  return /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)/i.test(value);
}

function isRedactableLiteral(value: string): boolean {
  return value.length >= 4 && value.length <= 4_096 && !value.includes("${");
}

function redactLogEntry(entry: SwarmServiceLogEntry, literals: string[]): SwarmServiceLogEntry & { level: "info" | "warn" | "error" } {
  const redact = (value: string) => {
    let result = value;
    for (const literal of literals) result = result.replaceAll(literal, "[REDACTED]");
    return result
    .replace(/\b(?:authorization|bearer)\s+[^\s,;]+/gi, (match) => `${match.split(/\s+/)[0]} [REDACTED]`)
    .replace(/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]");
  };
  const message = redact(entry.message);
  const level = /\b(error|fatal|panic|exception|fail(?:ed|ure)?)\b/i.test(message)
    ? "error"
    : /\b(warn(?:ing)?)\b/i.test(message)
      ? "warn"
      : "info";
  return { ...entry, raw: redact(entry.raw), message, level };
}

/** Factory form makes operational ownership and source persistence testable. */
export function createSwarmOperationsService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    featureEnabled: swarmSupportEnabled,
    getStack: (projectId, organizationId) => repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    resolvePlatform: async (serverId, organizationId) =>
      resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    waitForConvergence: (input) => swarmConvergence.wait(input),
    refresh: (projectId, organizationId) => swarmObservation.refresh(projectId, organizationId),
    updateSource: (stack, source) =>
      repos.swarmStack.updateSourceInOrganization(stack.id, stack.organizationId, source.expectedVersion, {
        sourceKind: source.kind,
        sourceStatus: "valid",
        sourcePaths: source.sourcePaths,
        sourcePath: source.sourcePath,
        sourceBranch: source.sourceBranch,
        sourceCommitSha: source.sourceCommitSha,
        sourceYamlEnc: encryptSecretField(source.inlineYaml),
        sourceDigest: source.sourceDigest,
      }),
    updateStack: (id, organizationId, patch) => repos.swarmStack.updateInOrganization(id, organizationId, patch),
    getProject: (projectId) => repos.project.findById(projectId),
    updateDeploymentStatus: (deploymentId, status, patch) => repos.deployment.updateStatus(deploymentId, status, patch),
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };

  async function waitForRemoval(runtime: Pick<StackRuntimeAdapter, "discover">, stackName: string) {
    const deadline = deps.now() + 45_000;
    let attempts = 0;
    while (true) {
      attempts++;
      try {
        const snapshot = await runtime.discover();
        const remaining = snapshot.services.filter((service) => service.stackName === stackName);
        if (remaining.length === 0) return { state: "removed" as const, attempts, remaining: [] as string[] };
        if (deps.now() >= deadline) return { state: "reconciling" as const, attempts, remaining: remaining.map((service) => service.sourceServiceName).sort() };
      } catch (error) {
        if (isConnectionLoss(error)) return { state: "reconciling" as const, attempts, remaining: [] as string[] };
        throw error;
      }
      await deps.sleep(Math.min(2_000, Math.max(0, deadline - deps.now())));
    }
  }

  async function resolveLogTarget(input: {
    projectId: string;
    organizationId: string;
    serviceName: string;
    taskId?: string;
  }) {
    if (!deps.featureEnabled()) {
      throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
    }
    const stack = await deps.getStack(input.projectId, input.organizationId);
    if (!stack) throw new NotFoundError("Swarm stack for project", input.projectId);
    if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");
    const platform = await deps.resolvePlatform(stack.managerServerId, input.organizationId);
    const runtime = platform.stackRuntime;
    if (!runtime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
    const snapshot = await runtime.discover();
    if (snapshot.manager.clusterId !== stack.clusterId) {
      throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
    }
    const service = snapshot.services.find((candidate) =>
      candidate.stackName === stack.stackName && candidate.sourceServiceName === input.serviceName,
    );
    if (!service) throw new NotFoundError("Swarm service", input.serviceName);
    // An observed stack has no OpenShip ownership label by design, but it is
    // already bound to this project and logs remain strictly read-only. Managed
    // stacks must keep their stronger label boundary even for a read operation.
    if (stack.managementMode === "managed" && !isOwned(service, stack)) {
      throw new AppError("This service is not labeled as managed by this OpenShip project.", 409, "SWARM_SERVICE_OWNERSHIP_CONFLICT");
    }
    if (input.taskId && !snapshot.tasks.some((task) => task.id === input.taskId && task.serviceId === service.id)) {
      throw new AppError("The requested task is not part of this live Swarm service.", 404, "SWARM_TASK_NOT_FOUND");
    }
    if (service.loggingDriver && NON_READABLE_LOG_DRIVERS.has(service.loggingDriver.toLowerCase())) {
      throw new AppError(
        `The ${service.loggingDriver} logging driver does not expose manager-readable service logs. Configure json-file or journald to use this view.`,
        409,
        "SWARM_LOG_DRIVER_UNSUPPORTED",
      );
    }
    return { stack, runtime, service };
  }

  return {
    async scale(input: {
      projectId: string;
      organizationId: string;
      serviceName: string;
      replicas: number;
      persistence: ScalePersistence;
    }) {
      if (!deps.featureEnabled()) {
        throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
      }
      if (!Number.isInteger(input.replicas) || input.replicas < 0 || input.replicas > 10_000) {
        throw new AppError("Replica count must be a non-negative integer no greater than 10,000.", 400, "SWARM_REPLICA_COUNT_INVALID");
      }
      const stack = await deps.getStack(input.projectId, input.organizationId);
      if (!stack) throw new NotFoundError("Swarm stack for project", input.projectId);
      if (stack.managementMode !== "managed") {
        throw new AppError("This stack is observed only. Claim management before changing a service.", 409, "SWARM_MANAGEMENT_REQUIRED");
      }
      if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");

      const platform = await deps.resolvePlatform(stack.managerServerId, input.organizationId);
      if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      const snapshot = await platform.stackRuntime.discover();
      if (snapshot.manager.clusterId !== stack.clusterId) {
        throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
      }
      const service = snapshot.services.find((candidate) =>
        candidate.stackName === stack.stackName && candidate.sourceServiceName === input.serviceName,
      );
      if (!service) throw new NotFoundError("Swarm service", input.serviceName);
      if (!isOwned(service, stack)) {
        throw new AppError("This service is not labeled as managed by this OpenShip project.", 409, "SWARM_SERVICE_OWNERSHIP_CONFLICT");
      }
      if (service.mode === "global") {
        throw new AppError("Global services run once per eligible node and cannot be scaled.", 409, "SWARM_SERVICE_SCALE_GLOBAL");
      }
      if (service.mode === "replicated-job" || service.mode === "global-job") {
        throw new AppError("Swarm job services use completion targets and cannot be scaled as long-running replicas.", 409, "SWARM_SERVICE_SCALE_JOB");
      }
      if (service.mode !== "replicated") {
        throw new AppError("This Swarm service mode does not support replica scaling.", 409, "SWARM_SERVICE_SCALE_UNSUPPORTED");
      }

      // Validate the requested durable source edit before mutating Docker. A
      // stale inline document therefore fails closed without leaving a runtime
      // change that the caller had asked to preserve.
      const source = input.persistence === "inline-source"
        ? scaleSourceYaml(stack, input.serviceName, input.replicas)
        : null;
      const operation = await platform.stackRuntime.scaleService({ serviceId: service.id, replicas: input.replicas });
      const convergence = await deps.waitForConvergence({
        runtime: platform.stackRuntime,
        stackName: stack.stackName,
        logger: { log: () => {} },
      });
      const health = convergence.snapshot && convergence.health
        ? convergence.health
        : deriveSwarmStackHealth({ stackName: stack.stackName, services: [], tasks: [] });
      const state = convergence.status === "ready" ? "ready" : convergence.status === "failed" ? "failed" : "reconciling";

      let sourcePersisted = false;
      let sourcePersistenceWarning: string | undefined;
      if (source && state !== "failed") {
        const updated = await deps.updateSource(stack, source);
        if (updated) sourcePersisted = true;
        else sourcePersistenceWarning = "The scale was applied, but the inline source changed concurrently. It remains an operational override until you update source and redeploy.";
      }
      // Refresh stores the operation as managed drift until a separately
      // reviewed source deploy makes the same replica target authoritative.
      let drift: unknown;
      if (convergence.snapshot) {
        try {
          drift = await deps.refresh(input.projectId, input.organizationId);
        } catch (error) {
          if (!isConnectionLoss(error)) throw error;
        }
      }
      return {
        serviceName: input.serviceName,
        replicas: input.replicas,
        persistence: input.persistence,
        sourcePersisted,
        ...(sourcePersistenceWarning ? { sourcePersistenceWarning } : {}),
        state,
        output: operation.output,
        health,
        ...(drift ? { drift } : {}),
      };
    },

    async restart(input: {
      projectId: string;
      organizationId: string;
      serviceName: string;
    }) {
      if (!deps.featureEnabled()) {
        throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
      }
      const stack = await deps.getStack(input.projectId, input.organizationId);
      if (!stack) throw new NotFoundError("Swarm stack for project", input.projectId);
      if (stack.managementMode !== "managed") {
        throw new AppError("This stack is observed only. Claim management before restarting a service.", 409, "SWARM_MANAGEMENT_REQUIRED");
      }
      if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");
      const platform = await deps.resolvePlatform(stack.managerServerId, input.organizationId);
      if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      const snapshot = await platform.stackRuntime.discover();
      if (snapshot.manager.clusterId !== stack.clusterId) {
        throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
      }
      const service = snapshot.services.find((candidate) =>
        candidate.stackName === stack.stackName && candidate.sourceServiceName === input.serviceName,
      );
      if (!service) throw new NotFoundError("Swarm service", input.serviceName);
      if (!isOwned(service, stack)) {
        throw new AppError("This service is not labeled as managed by this OpenShip project.", 409, "SWARM_SERVICE_OWNERSHIP_CONFLICT");
      }
      if (service.mode === "replicated-job" || service.mode === "global-job") {
        throw new AppError("Swarm job services cannot be force-restarted as long-running services.", 409, "SWARM_SERVICE_RESTART_JOB");
      }
      const previousTaskIds = snapshot.tasks.filter((task) => task.serviceId === service.id).map((task) => task.id).sort();
      const operation = await platform.stackRuntime.restartService({ serviceId: service.id });
      const convergence = await deps.waitForConvergence({
        runtime: platform.stackRuntime,
        stackName: stack.stackName,
        logger: { log: () => {} },
      });
      const state = convergence.status === "ready" ? "ready" : convergence.status === "failed" ? "failed" : "reconciling";
      let drift: unknown;
      if (convergence.snapshot) {
        try {
          drift = await deps.refresh(input.projectId, input.organizationId);
        } catch (error) {
          if (!isConnectionLoss(error)) throw error;
        }
      }
      return {
        serviceName: input.serviceName,
        serviceId: service.id,
        previousTaskIds,
        state,
        output: operation.output,
        health: convergence.health,
        ...(drift ? { drift } : {}),
      };
    },

    async logs(input: {
      projectId: string;
      organizationId: string;
      serviceName: string;
      taskId?: string;
      tail?: number;
      since?: string;
      timestamps?: boolean;
    }) {
      const target = await resolveLogTarget(input);
      const result = await target.runtime.getServiceLogs({
        serviceId: target.service.id,
        taskId: input.taskId,
        tail: input.tail,
        since: input.since,
        timestamps: input.timestamps,
      });
      const literals = sensitiveEnvironmentValues(target.stack);
      return {
        serviceName: target.service.sourceServiceName,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        loggingDriver: target.service.loggingDriver,
        entries: result.entries.map((entry) => redactLogEntry(entry, literals)),
      };
    },

    async streamLogs(
      input: {
        projectId: string;
        organizationId: string;
        serviceName: string;
        taskId?: string;
        tail?: number;
        since?: string;
        timestamps?: boolean;
      },
      onEntry: (entry: SwarmServiceLogEntry & { level: "info" | "warn" | "error" }) => void,
    ) {
      const target = await resolveLogTarget(input);
      const literals = sensitiveEnvironmentValues(target.stack);
      const stream = target.runtime.streamServiceLogs({
        serviceId: target.service.id,
        taskId: input.taskId,
        tail: input.tail,
        since: input.since,
        timestamps: input.timestamps,
      }, (entry) => onEntry(redactLogEntry(entry, literals)));
      return {
        serviceName: target.service.sourceServiceName,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        loggingDriver: target.service.loggingDriver,
        ...stream,
      };
    },

    async remove(input: {
      projectId: string;
      organizationId: string;
      confirmedStackName: string;
    }) {
      if (!deps.featureEnabled()) {
        throw new AppError("Docker Swarm support is not enabled on this OpenShip instance.", 404, "SWARM_FEATURE_DISABLED");
      }
      const stack = await deps.getStack(input.projectId, input.organizationId);
      if (!stack) throw new NotFoundError("Swarm stack for project", input.projectId);
      if (stack.managementMode !== "managed") {
        throw new AppError("Only a managed OpenShip stack can be removed. Observed stacks are read-only.", 409, "SWARM_MANAGEMENT_REQUIRED");
      }
      if (input.confirmedStackName.trim() !== stack.stackName) {
        throw new AppError("Type the exact managed stack name to confirm removal.", 400, "SWARM_REMOVE_CONFIRMATION_INVALID");
      }
      if (!stack.managerServerId) throw new AppError("This stack no longer has a Swarm manager target.", 409, "SWARM_MANAGER_UNAVAILABLE");
      const platform = await deps.resolvePlatform(stack.managerServerId, input.organizationId);
      if (!platform.stackRuntime) throw new AppError("Docker Swarm is unavailable for this target.", 503, "SWARM_MANAGER_UNAVAILABLE");
      const snapshot = await platform.stackRuntime.discover();
      if (snapshot.manager.clusterId !== stack.clusterId) {
        throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
      }
      const services = snapshot.services.filter((service) => service.stackName === stack.stackName);
      const foreign = services.filter((service) => !isOwned(service, stack));
      if (foreign.length > 0) {
        throw new AppError(
          `Refusing to remove ${stack.stackName}: ${foreign.map((service) => service.sourceServiceName).join(", ")} is not labeled as managed by this OpenShip project.`,
          409,
          "SWARM_STACK_OWNERSHIP_CONFLICT",
        );
      }
      const persistentObjects = stackOwnedPersistentObjects(snapshot, stack);
      if (persistentObjects.length > 0) {
        throw new AppError(
          `Refusing to remove ${stack.stackName}: docker stack rm would delete ${persistentObjects.join(", ")}. Mark these configs and secrets external before removal so their data remains available.`,
          409,
          "SWARM_PERSISTENT_OBJECT_PRECONDITION",
        );
      }
      let output: string;
      try {
        output = (await platform.stackRuntime.removeStack({ stackName: stack.stackName })).output;
      } catch (error) {
        if (!isConnectionLoss(error)) throw error;
        // A dropped transport after the manager accepted `stack rm` is not a
        // failed removal. Never repeat it blindly: verify absence instead.
        output = "Manager connection was lost after the removal request; verifying live service absence.";
      }
      const result = await waitForRemoval(platform.stackRuntime, stack.stackName);
      if (result.state === "removed") {
        await deps.updateStack(stack.id, input.organizationId, {
          lastObservedAt: new Date(),
          lastObservedDigest: null,
          observedState: { services: [] },
          driftStatus: "unknown",
          driftDetails: {
            summary: "Managed stack was removed by OpenShip; persistent resources were intentionally preserved.",
            operation: { kind: "remove", state: "removed" },
          },
        });
        const project = await deps.getProject(input.projectId);
        if (project?.activeDeploymentId) {
          await deps.updateDeploymentStatus(project.activeDeploymentId, "cancelled", {
            errorMessage: "Managed Swarm stack was removed by an operator. Persistent resources were preserved.",
          });
        }
      } else {
        await deps.updateStack(stack.id, input.organizationId, {
          driftStatus: "unknown",
          driftDetails: {
            summary: "Stack removal was accepted but the manager could not yet confirm service absence; reconciliation is required.",
            operation: { kind: "remove", state: "reconciling" },
            remainingServices: result.remaining,
          },
        });
      }
      return {
        stackName: stack.stackName,
        affectedServices: services.map((service) => service.sourceServiceName).sort(),
        state: result.state,
        attempts: result.attempts,
        ...(result.remaining.length ? { remainingServices: result.remaining } : {}),
        output,
      };
    },
  };
}

export const swarmOperations = createSwarmOperationsService();
