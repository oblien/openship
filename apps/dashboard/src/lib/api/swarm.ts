import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

export type SwarmHealthState =
  | "ready"
  | "partial_failure"
  | "deploying"
  | "reconciling"
  | "failed"
  | "empty"
  | "unreachable";

export interface SwarmManager {
  engineVersion: string | null;
  apiVersion: string | null;
  clusterId: string;
  nodeId: string;
  nodeAddress: string | null;
  managerAddress: string | null;
}

export interface SwarmNode {
  id: string;
  hostname: string;
  status: string;
  availability: string;
  managerStatus: string | null;
  engineVersion: string | null;
  labels: Record<string, string>;
}

export interface SwarmTask {
  id: string;
  serviceId: string;
  serviceName: string;
  slot: number | null;
  nodeId: string | null;
  nodeName: string | null;
  desiredState: string;
  currentState: string;
  error: string | null;
  image: string | null;
  updatedAt: string | null;
  observedAt: string;
}

export interface SwarmServiceView {
  id: string;
  name: string;
  sourceServiceName: string;
  mode: string;
  image: string | null;
  health: {
    state: string;
    desired: number | null;
    running: number;
    pending: number;
    failed: number;
    diagnostics: string[];
  };
  taskCount: number;
  nodeIds: string[];
  portainerManaged: boolean;
}

export interface SwarmStackView {
  name: string;
  health: {
    state: SwarmHealthState;
    diagnostics: string[];
  };
  services: SwarmServiceView[];
  networks: string[];
  volumes: string[];
  configs: string[];
  secrets: string[];
  portainerManaged: boolean;
}

export interface SwarmDiscoveryView {
  stacks: SwarmStackView[];
  standaloneServices: SwarmServiceView[];
  observedAt: string;
  diagnostics: Array<{ resource: string; message: string }>;
}

export interface SwarmSummary {
  manager: SwarmManager;
  observedAt: string;
  stacks: Array<{
    stackName: string;
    state: SwarmHealthState;
    diagnostics: string[];
    services: Array<{
      serviceId: string;
      state: string;
      desired: number | null;
      running: number;
      pending: number;
      failed: number;
    }>;
  }>;
  diagnostics: Array<{ resource: string; message: string }>;
}

export interface SwarmStackDetail {
  stack: { name: string; serviceIds: string[]; serviceNames: string[] };
  health: { state: SwarmHealthState; diagnostics: string[] };
  services: Array<{
    id: string;
    name: string;
    sourceServiceName: string;
    mode: string;
    specVersion: number | null;
    desiredReplicas: number | null;
    image: string | null;
    loggingDriver?: string | null;
    endpointMode: string | null;
    networks: string[];
    volumes?: string[];
    configs: string[];
    secrets: string[];
    publishedPorts: Array<{ target: number; published: number | null; protocol: string; mode: string }>;
    updateState: string | null;
    updateMessage: string | null;
    /** Selected routing labels are informational; OpenShip does not mutate them in external mode. */
    routingLabels: Array<{ key: string; value: string | null; redacted: boolean }>;
    routingUrls: string[];
  }>;
  tasks: SwarmTask[];
  observedAt: string;
  diagnostics: Array<{ resource: string; message: string }>;
}

export interface SwarmObservation {
  stackName: string;
  managerServerId: string | null;
  clusterId: string;
  managementMode: "observe" | "managed";
  revisionId: string | null;
  source: {
    kind: "repository" | "inline" | "adopted";
    status: "missing" | "linked-unvalidated" | "valid" | "invalid";
    deployable: boolean;
  };
  drift: {
    status: "unknown" | "clean" | "drifted" | "unreachable";
    details: Record<string, unknown> | null;
    lastObservedAt: string | null;
    digest: string | null;
  };
}

export interface SwarmManagerConnection {
  expectedClusterId: string;
  manager: {
    server: { id: string; name: string | null; endpoint: string; isLocal: boolean } | null;
    health: "healthy" | "unreachable" | "wrong-cluster" | "missing";
    managerState: "active-manager" | "manager-required" | "unreachable" | "missing";
    controlAvailable: boolean | null;
    clusterId: string | null;
    nodeId: string | null;
    nodeAddress: string | null;
    managerAddress: string | null;
    lastSuccessfulProbeAt: string | null;
    lastError: string | null;
    nodes: SwarmNode[];
  };
  candidates: Array<{ id: string; name: string | null; endpoint: string; isCurrent: boolean }>;
}

/** Safe descriptor only; normal reads intentionally never include inline YAML. */
export interface SwarmStackSource {
  kind: "repository" | "inline" | "adopted";
  status: "missing" | "linked-unvalidated" | "valid" | "invalid";
  composePaths: string[];
  sourcePath: string | null;
  branch: string | null;
  commitSha: string | null;
  version: number;
  digest: string | null;
  deployable: boolean;
  hasInlineYaml: boolean;
  routingMode: "external" | "openship-edge";
  registryId: string | null;
  storageAcknowledgements: string[];
  volumeReplacementAcknowledgements: string[];
}

export type SwarmPreviewChangeKind =
  | "stack-create"
  | "service-add"
  | "service-remove"
  | "image-change"
  | "replica-mode-change"
  | "placement-resource-change"
  | "network-port-change"
  | "config-secret-reference-change"
  | "labels-routing-change";

export interface SwarmSourcePreview {
  valid: true;
  sourceDigest: string | null;
  renderedDigest: string;
  redactedRenderedYaml: string;
  changes: Array<{ kind: SwarmPreviewChangeKind; serviceName?: string; summary: string }>;
  cannotCompareExactly: string[];
  liveStateDigest: string;
  noOp: boolean;
  warnings: string[];
  compatibility: {
    blockers: Array<{ code: string; message: string; remediation: string; serviceName?: string; acknowledgementKey?: string }>;
    warnings: Array<{ code: string; message: string; remediation: string; serviceName?: string; acknowledgementKey?: string }>;
  };
}

export interface SwarmStackHandoff {
  stackName: string;
  managementMode: "observe" | "managed";
  source: SwarmStackSource & { inlineYaml?: string };
  overrideYaml: string | null;
  revision: { id: string; number: number; renderedDigest: string } | null;
  notes: string[];
}

export interface SwarmScaleResult {
  serviceName: string;
  replicas: number;
  persistence: "temporary" | "inline-source";
  sourcePersisted: boolean;
  sourcePersistenceWarning?: string;
  state: "ready" | "failed" | "reconciling";
  output: string;
}

export interface SwarmRestartResult {
  serviceName: string;
  serviceId: string;
  previousTaskIds: string[];
  state: "ready" | "failed" | "reconciling";
  output: string;
}

export interface SwarmRemoveResult {
  stackName: string;
  affectedServices: string[];
  state: "removed" | "reconciling";
  attempts: number;
  remainingServices?: string[];
  output: string;
}

export interface SwarmLogEntry {
  raw: string;
  timestamp: string | null;
  message: string;
  serviceName: string | null;
  taskId: string | null;
  nodeName: string | null;
  level: "info" | "warn" | "error";
}

export interface SwarmServiceLogsResult {
  serviceName: string;
  taskId?: string;
  loggingDriver: string | null;
  entries: SwarmLogEntry[];
}

export type SwarmLogOptions = {
  taskId?: string;
  tail?: number;
  since?: string;
  timestamps?: boolean;
};

function serviceLogPath(projectId: string, serviceName: string): string {
  return `projects/${projectId}/swarm/services/${encodeURIComponent(serviceName)}/logs`;
}

export const swarmApi = {
  summary: (serverId: string) => api.get<SwarmSummary>(`swarm/${serverId}/summary`),
  stacks: (serverId: string) => api.get<SwarmDiscoveryView>(`swarm/${serverId}/stacks`),
  nodes: (serverId: string) => api.get<{ nodes: SwarmNode[]; observedAt: string }>(`swarm/${serverId}/nodes`),
  stack: (serverId: string, stackName: string) =>
    api.get<SwarmStackDetail>(`swarm/${serverId}/stacks/${encodeURIComponent(stackName)}`),
  observe: (serverId: string, stackName: string) =>
    api.post<{ projectId: string; stackId: string; created: boolean; observedDigest: string | null }>(
      `swarm/${serverId}/stacks/${encodeURIComponent(stackName)}/observe`,
      {},
    ),
  observation: (projectId: string) =>
    api.get<SwarmObservation>(`projects/${projectId}/swarm/observation`),
  connection: (projectId: string) =>
    api.get<SwarmManagerConnection>(`projects/${projectId}/swarm/connection`),
  rebindManager: (projectId: string, serverId: string) =>
    api.post<{ managerServerId: string; clusterId: string; endpoint: string }>(
      `projects/${projectId}/swarm/connection/rebind`,
      { serverId },
    ),
  createStackBinding: (projectId: string, input: { serverId: string; stackName: string }) =>
    api.post<{ projectId: string; managerServerId: string; clusterId: string; stackName: string; managementMode: "observe" }>(
      endpoints.projects.swarmStack(projectId),
      input,
    ),
  source: (projectId: string) =>
    api.get<{ source: SwarmStackSource }>(`projects/${projectId}/swarm/source`).then((result) => result.source),
  replaceSource: (
    projectId: string,
    input:
      | { kind: "inline"; yaml: string; expectedVersion: number }
      | { kind: "repository"; composePaths: string[]; sourcePath?: string; branch?: string; commitSha?: string; expectedVersion: number },
  ) =>
    api.put<{ source: SwarmStackSource }>(`projects/${projectId}/swarm/source`, input).then((result) => result.source),
  setRegistry: (projectId: string, registryId: string | null) =>
    api.patch<{ source: SwarmStackSource }>(`projects/${projectId}/swarm/registry`, { registryId }).then((result) => result.source),
  setRoutingMode: (projectId: string, routingMode: SwarmStackSource["routingMode"]) =>
    api.patch<{ source: SwarmStackSource }>(`projects/${projectId}/swarm/routing`, { routingMode }).then((result) => result.source),
  setStorageAcknowledgements: (projectId: string, acknowledgements: string[]) =>
    api.put<{ source: SwarmStackSource }>(`projects/${projectId}/swarm/storage-acknowledgements`, { acknowledgements }).then((result) => result.source),
  setVolumeReplacementAcknowledgements: (projectId: string, acknowledgements: string[]) =>
    api.put<{ source: SwarmStackSource }>(`projects/${projectId}/swarm/volume-replacement-acknowledgements`, { acknowledgements }).then((result) => result.source),
  renderSource: (projectId: string, environment: Record<string, string> = {}) =>
    api.post<SwarmSourcePreview>(`projects/${projectId}/swarm/source/render`, { environment }),
  claimManagement: (projectId: string, input: { confirmedStackName: string; previewLiveDigest: string }) =>
    api.post<{ stackName: string; managementMode: "observe"; claimPending: true; liveDigest: string }>(
      `projects/${projectId}/swarm/claim`,
      input,
    ),
  releaseManagement: (projectId: string, confirmedStackName: string) =>
    api.post<{ stackName: string; managementMode: "observe"; released: true }>(
      `projects/${projectId}/swarm/release-management`,
      { confirmedStackName },
    ),
  handoff: (projectId: string) => api.get<SwarmStackHandoff>(`projects/${projectId}/swarm/handoff`),
  refreshObservation: (projectId: string) =>
    api.post<{ status: "clean" | "drifted"; digest: string; changed: boolean; details: Record<string, unknown> }>(
      `projects/${projectId}/swarm/observation/refresh`,
      {},
    ),
  scaleService: (
    projectId: string,
    serviceName: string,
    input: { replicas: number; persistence: "temporary" | "inline-source" },
  ) =>
    api.post<SwarmScaleResult>(
      `projects/${projectId}/swarm/services/${encodeURIComponent(serviceName)}/scale`,
      input,
    ),
  restartService: (projectId: string, serviceName: string) =>
    api.post<SwarmRestartResult>(
      `projects/${projectId}/swarm/services/${encodeURIComponent(serviceName)}/restart`,
      {},
    ),
  removeStack: (projectId: string, confirmedStackName: string) =>
    api.post<SwarmRemoveResult>(`projects/${projectId}/swarm/remove`, { confirmedStackName }),
  serviceLogs: (projectId: string, serviceName: string, options: SwarmLogOptions = {}) =>
    api.get<{ data: SwarmServiceLogsResult }>(serviceLogPath(projectId, serviceName), { params: options })
      .then((response) => response.data),
  serviceLogStreamUrl: (projectId: string, serviceName: string, options: SwarmLogOptions = {}) => {
    const url = new URL(`${serviceLogPath(projectId, serviceName)}/stream`, getApiBaseUrl());
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  },
};
