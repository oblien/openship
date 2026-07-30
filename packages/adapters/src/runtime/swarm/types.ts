/** Stable, read-only manager identity returned by the initial Swarm probe. */
export interface SwarmManagerInfo {
  engineVersion: string | null;
  apiVersion: string | null;
  localNodeState: "active";
  controlAvailable: true;
  clusterId: string;
  nodeId: string;
  nodeAddress: string | null;
  managerAddress: string | null;
}

export type SwarmProbeFailureCode =
  | "SWARM_MANAGER_UNREACHABLE"
  | "SWARM_INACTIVE"
  | "SWARM_MANAGER_REQUIRED"
  | "SWARM_INVALID_INFO";

/** Lifecycle surface for stack-oriented runtimes, separate from RuntimeAdapter. */
export interface StackRuntimeAdapter {
  readonly name: "swarm";
  probe(): Promise<SwarmManagerInfo>;
  discover(): Promise<SwarmDiscoverySnapshot>;
  renderStack(input: RenderStackInput): Promise<RenderedStack>;
  /** Applies a reviewed, non-interpolated document through the manager. */
  deployStack(input: DeployStackInput): Promise<DeployedStack>;
  /** The platform owns any shared SSH executor; this adapter has no implicit teardown. */
  dispose?(): Promise<void>;
}

/** One source file materialized only in the manager's ephemeral render directory. */
export interface SwarmRenderSourceFile {
  /** Repository-relative path; absolute/traversal paths are rejected. */
  path: string;
  content: string;
}

export interface RenderStackInput {
  composePaths: string[];
  files: SwarmRenderSourceFile[];
  /** Explicit interpolation map. The manager shell starts with `env -i`. */
  environment?: Record<string, string>;
  /** Minimal, generated overlay; source files are never rewritten. */
  /** Service name → generated service labels. */
  ownershipLabels?: Record<string, Record<string, string>>;
}

export interface SwarmRenderIssue {
  code: "SWARM_STACK_CONFIG_FAILED" | "SWARM_STACK_INTERPOLATION_FAILED" | "SWARM_STACK_RENDER_UNAVAILABLE";
  message: string;
}

export interface RenderedStack {
  /** Exact Docker-produced config; callers must encrypt/redact before persistence or DTO use. */
  renderedYaml: string;
  renderedDigest: string;
  overrideYaml: string;
  warnings: string[];
}

/** The deploy adapter accepts Docker-rendered config, never source documents. */
export interface DeployStackInput {
  stackName: string;
  renderedYaml: string;
  /** Managed-stack pruning remains an explicit caller decision. */
  prune?: boolean;
  resolveImage?: "always" | "changed" | "never";
  /** Credential setup remains outside this API; this only adds Docker's flag. */
  withRegistryAuth?: boolean;
}

export interface DeployedStack {
  /** Bounded Docker CLI output suitable for deployment logs. */
  output: string;
}

export interface SwarmDiscoveryDiagnostic {
  resource: "nodes" | "services" | "tasks" | "networks" | "volumes" | "configs" | "secrets";
  message: string;
}

export interface SwarmNodeState {
  id: string;
  hostname: string;
  status: string;
  availability: string;
  managerStatus: string | null;
  engineVersion: string | null;
  labels: Record<string, string>;
}

export type SwarmServiceMode = "replicated" | "global" | "replicated-job" | "global-job" | "unknown";

export interface SwarmPublishedPort {
  target: number;
  published: number | null;
  protocol: "tcp" | "udp" | "sctp" | string;
  mode: "ingress" | "host" | string;
}

export interface SwarmServiceState {
  id: string;
  name: string;
  /** Name inside the stack document, without Docker's `<stack>_` prefix. */
  sourceServiceName: string;
  stackName: string | null;
  specVersion: number | null;
  mode: SwarmServiceMode;
  desiredReplicas: number | null;
  image: string | null;
  labels: Record<string, string>;
  endpointMode: string | null;
  placement: Record<string, unknown> | null;
  resources: Record<string, unknown> | null;
  updateConfig: Record<string, unknown> | null;
  rollbackConfig: Record<string, unknown> | null;
  restartPolicy: Record<string, unknown> | null;
  networks: string[];
  configs: string[];
  secrets: string[];
  publishedPorts: SwarmPublishedPort[];
  updateState: string | null;
  updateMessage: string | null;
}

export interface SwarmTaskState {
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
  /** Manager-provided update timestamp when available; falls back to observedAt. */
  updatedAt: string | null;
  observedAt: string;
}

export type SwarmServiceHealthState =
  | "converged"
  | "updating"
  | "degraded"
  | "paused"
  | "failed"
  | "scaled-to-zero"
  | "unknown";

export interface SwarmServiceHealth {
  serviceId: string;
  state: SwarmServiceHealthState;
  desired: number | null;
  running: number;
  pending: number;
  failed: number;
  completed: number;
  currentTasks: SwarmTaskState[];
  diagnostics: string[];
}

export type SwarmStackHealthState =
  | "ready"
  | "partial_failure"
  | "deploying"
  | "reconciling"
  | "failed"
  | "empty"
  | "unreachable";

export interface SwarmStackHealth {
  stackName: string;
  state: SwarmStackHealthState;
  services: SwarmServiceHealth[];
  diagnostics: string[];
}

export interface SwarmStackState {
  name: string;
  serviceIds: string[];
  serviceNames: string[];
}

export interface SwarmNetworkState {
  id: string;
  name: string;
  driver: string | null;
  scope: string | null;
  labels: Record<string, string>;
}

export interface SwarmVolumeState {
  name: string;
  driver: string | null;
  scope: string | null;
  labels: Record<string, string>;
  options: Record<string, string>;
}

/** Metadata only — never secret/config payloads. */
export interface SwarmNamedObjectState {
  id: string;
  name: string;
  labels: Record<string, string>;
  createdAt: string | null;
}

export interface SwarmDiscoverySnapshot {
  manager: SwarmManagerInfo;
  nodes: SwarmNodeState[];
  stacks: SwarmStackState[];
  services: SwarmServiceState[];
  tasks: SwarmTaskState[];
  networks: SwarmNetworkState[];
  volumes: SwarmVolumeState[];
  configs: SwarmNamedObjectState[];
  secrets: SwarmNamedObjectState[];
  diagnostics: SwarmDiscoveryDiagnostic[];
  observedAt: string;
}
