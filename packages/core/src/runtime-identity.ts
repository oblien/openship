import type { DeployTarget, OrchestratorMode, RuntimeMode } from "./types";

/** Durable workload identity. A Swarm stack is intentionally not a container. */
export type RuntimeWorkloadRef =
  | { kind: "container"; containerId: string }
  | { kind: "bare-process"; processId: string }
  | { kind: "cloud-workspace"; workspaceId: string }
  | { kind: "cloud-page"; pageSlug: string }
  | {
      kind: "swarm-stack";
      clusterId: string;
      managerServerId: string;
      stackName: string;
      revisionId: string;
    };

/** Durable service identity. A Swarm service can be recreated with a new ID. */
export type RuntimeServiceRef =
  | { kind: "container"; containerId: string }
  | { kind: "bare-process"; processId: string }
  | { kind: "cloud-workload"; workspaceId: string; workloadName?: string }
  | {
      kind: "swarm-service";
      clusterId: string;
      stackName: string;
      serviceId: string;
      serviceName: string;
      specVersion: number;
    };

/**
 * Derived service fields retained for search and dashboard display. The source
 * stack document remains authoritative; this must never be rendered back into
 * a replacement stack file.
 */
export type SwarmServiceProjection = {
  sourceServiceName: string;
  observedServiceId?: string;
  mode: "replicated" | "global" | "replicated-job" | "global-job" | "unknown";
  replicas?: { desired?: number; running?: number; completed?: number };
  image?: string;
  endpointMode?: string;
  placement?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  updateConfig?: Record<string, unknown>;
  rollbackConfig?: Record<string, unknown>;
  restartPolicy?: Record<string, unknown>;
  labels?: Record<string, string>;
  publishedPorts?: Array<Record<string, unknown>>;
  networks?: string[];
  configs?: string[];
  secrets?: string[];
  observedAt?: string;
  sourceState: "present" | "removed";
};

export type RuntimeRefParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Parse untrusted API/JSONB input without accepting a near-match as a ref. */
export function parseRuntimeWorkloadRef(value: unknown): RuntimeRefParseResult<RuntimeWorkloadRef> {
  const input = record(value);
  const kind = text(input?.kind);
  if (!input || !kind) return { ok: false, error: "Runtime workload reference must include a kind." };

  switch (kind) {
    case "container": {
      const containerId = text(input.containerId);
      return containerId
        ? { ok: true, value: { kind, containerId } }
        : { ok: false, error: "Container runtime reference must include containerId." };
    }
    case "bare-process": {
      const processId = text(input.processId);
      return processId
        ? { ok: true, value: { kind, processId } }
        : { ok: false, error: "Bare-process runtime reference must include processId." };
    }
    case "cloud-workspace": {
      const workspaceId = text(input.workspaceId);
      return workspaceId
        ? { ok: true, value: { kind, workspaceId } }
        : { ok: false, error: "Cloud-workspace runtime reference must include workspaceId." };
    }
    case "cloud-page": {
      const pageSlug = text(input.pageSlug);
      return pageSlug
        ? { ok: true, value: { kind, pageSlug } }
        : { ok: false, error: "Cloud-page runtime reference must include pageSlug." };
    }
    case "swarm-stack": {
      const stackName = text(input.stackName);
      const clusterId = text(input.clusterId);
      const managerServerId = text(input.managerServerId);
      const revisionId = text(input.revisionId);
      return stackName && clusterId && managerServerId && revisionId
        ? { ok: true, value: { kind, stackName, clusterId, managerServerId, revisionId } }
        : {
            ok: false,
            error:
              "Swarm-stack runtime reference must include clusterId, managerServerId, stackName, and revisionId.",
          };
    }
    default:
      return { ok: false, error: `Unsupported runtime workload reference kind: ${kind}.` };
  }
}

/** Parse untrusted API/JSONB input without accepting a near-match as a ref. */
export function parseRuntimeServiceRef(value: unknown): RuntimeRefParseResult<RuntimeServiceRef> {
  const input = record(value);
  const kind = text(input?.kind);
  if (!input || !kind) return { ok: false, error: "Runtime service reference must include a kind." };

  switch (kind) {
    case "container": {
      const containerId = text(input.containerId);
      return containerId
        ? { ok: true, value: { kind, containerId } }
        : { ok: false, error: "Container service reference must include containerId." };
    }
    case "bare-process": {
      const processId = text(input.processId);
      return processId
        ? { ok: true, value: { kind, processId } }
        : { ok: false, error: "Bare-process service reference must include processId." };
    }
    case "cloud-workload": {
      const workspaceId = text(input.workspaceId);
      const workloadName = optionalText(input.workloadName);
      return workspaceId
        ? { ok: true, value: { kind, workspaceId, ...(workloadName && { workloadName }) } }
        : { ok: false, error: "Cloud-workload service reference must include workspaceId." };
    }
    case "swarm-service": {
      const stackName = text(input.stackName);
      const serviceName = text(input.serviceName);
      const serviceId = text(input.serviceId);
      const clusterId = text(input.clusterId);
      const specVersion = nonNegativeInteger(input.specVersion);
      return stackName && serviceName && serviceId && clusterId && specVersion !== undefined
        ? {
            ok: true,
            value: {
              kind,
              stackName,
              serviceName,
              serviceId,
              clusterId,
              specVersion,
            },
          }
        : {
            ok: false,
            error:
              "Swarm-service runtime reference must include clusterId, stackName, serviceId, serviceName, and specVersion.",
          };
    }
    default:
      return { ok: false, error: `Unsupported runtime service reference kind: ${kind}.` };
  }
}

export function isSwarmStackRef(
  ref: RuntimeWorkloadRef | RuntimeServiceRef | null | undefined,
): ref is Extract<RuntimeWorkloadRef, { kind: "swarm-stack" }> {
  return ref?.kind === "swarm-stack";
}

export function isSwarmServiceRef(
  ref: RuntimeWorkloadRef | RuntimeServiceRef | null | undefined,
): ref is Extract<RuntimeServiceRef, { kind: "swarm-service" }> {
  return ref?.kind === "swarm-service";
}

type LegacyDeploymentLike = {
  runtimeRef?: unknown;
  containerId?: string | null;
  meta?: unknown;
};

type LegacyServiceDeploymentLike = {
  runtimeRef?: unknown;
  containerId?: string | null;
  deployment?: LegacyDeploymentLike | null;
};

function deploymentMeta(value: LegacyDeploymentLike): RecordValue | null {
  return record(value.meta);
}

/**
 * Reads a new typed workload reference first, then preserves deployed legacy
 * rows by translating their overloaded containerId field at the boundary.
 */
export function deploymentWorkloadRef(
  deployment: LegacyDeploymentLike | null | undefined,
): RuntimeWorkloadRef | undefined {
  if (!deployment) return undefined;
  const explicit = parseRuntimeWorkloadRef(deployment.runtimeRef ?? deploymentMeta(deployment)?.runtimeRef);
  if (explicit.ok) return explicit.value;

  const containerId = text(deployment.containerId);
  const meta = deploymentMeta(deployment);
  const runtimeMode = meta?.runtimeMode;
  const deployTarget = meta?.deployTarget;
  if (containerId?.startsWith("page:")) return { kind: "cloud-page", pageSlug: containerId.slice(5) };
  if (containerId && deployTarget === "cloud") return { kind: "cloud-workspace", workspaceId: containerId };
  if (containerId && runtimeMode === "bare") return { kind: "bare-process", processId: containerId };
  if (containerId) return { kind: "container", containerId };
  const workspaceId = text(meta?.workspaceId) ?? text(meta?.uploadWorkspaceId);
  return workspaceId ? { kind: "cloud-workspace", workspaceId } : undefined;
}

/** Same compatibility bridge for service_deployment rows. */
export function serviceWorkloadRef(
  serviceDeployment: LegacyServiceDeploymentLike | null | undefined,
): RuntimeServiceRef | undefined {
  if (!serviceDeployment) return undefined;
  const explicit = parseRuntimeServiceRef(serviceDeployment.runtimeRef);
  if (explicit.ok) return explicit.value;

  const containerId = text(serviceDeployment.containerId);
  const parentMeta = deploymentMeta(serviceDeployment.deployment ?? {});
  if (containerId && parentMeta?.runtimeMode === "bare") {
    return { kind: "bare-process", processId: containerId };
  }
  return containerId ? { kind: "container", containerId } : undefined;
}

export function resolveOrchestratorMode(value: unknown): OrchestratorMode {
  return value === "swarm" ? "swarm" : "standalone";
}

/**
 * The initial supported matrix. Keep this at the request/platform boundary so
 * a new orchestration value cannot silently fall through a `docker ? ... : bare`
 * branch before any Docker command is attempted.
 */
export function assertSupportedExecutionMatrix(input: {
  runtimeMode: RuntimeMode;
  orchestratorMode?: OrchestratorMode | null;
  deployTarget?: DeployTarget | null;
}): void {
  const orchestratorMode = resolveOrchestratorMode(input.orchestratorMode);
  if (orchestratorMode !== "swarm") return;
  if (input.runtimeMode !== "docker") {
    throw new Error("Docker Swarm orchestration requires runtimeMode 'docker'; 'bare' is unsupported.");
  }
  if (input.deployTarget === "cloud") {
    throw new Error("Docker Swarm orchestration is not supported on the cloud deployment target.");
  }
}
