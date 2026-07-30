import { api } from "./client";

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
    desiredReplicas: number | null;
    image: string | null;
    updateState: string | null;
    updateMessage: string | null;
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
  refreshObservation: (projectId: string) =>
    api.post<{ status: "clean" | "drifted"; digest: string; changed: boolean; details: Record<string, unknown> }>(
      `projects/${projectId}/swarm/observation/refresh`,
      {},
    ),
};
