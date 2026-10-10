/** Shared Actions protocol. The controller owns scheduling; a worker executes one job. */
export const ACTIONS_PROTOCOL_VERSION = 1;
export const ACTIONS_ENGINE_VERSION = "0.2.89";
export const ACTIONS_MAX_JOBS = 256;
export const ACTIONS_MAX_WORKFLOW_BYTES = 256 * 1024;
export const ACTIONS_MAX_LOG_BYTES = 8 * 1024 * 1024;
export const ACTIONS_MAX_JOB_SECONDS = 6 * 60 * 60;

/** Exactly one controller owns a workflow's scheduling and job results. */
export type ActionWorkflowController = "openship" | "github";

export interface ActionGitHubRun {
  id: string;
  workflowId: string;
  url: string;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}

export interface ActionGitHubJob {
  id: string;
  url: string;
  runnerId: string | null;
  runnerName: string | null;
  steps: Array<{
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
}

export type ActionConclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out";
export type ActionStatus = "queued" | "waiting" | "running" | "cancelling" | ActionConclusion;
export const ACTIONS_TERMINAL_STATUSES: readonly ActionStatus[] = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
];
export function actionFinished(status: string): status is ActionConclusion {
  return (ACTIONS_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type ActionArchitecture = "x64" | "arm64";
export type ActionContainerPlatform = "linux/amd64" | "linux/arm64";

export interface ActionCapabilities {
  os: "linux" | "macos";
  architecture: ActionArchitecture;
  docker: boolean;
  /** Docker may run in a VM or on a different CPU from the connected host. */
  dockerArchitecture?: ActionArchitecture;
  /** Platforms verified on the Docker daemon, including working binfmt emulators. */
  dockerPlatforms?: ActionContainerPlatform[];
  git: boolean;
  node: boolean;
  /** OS image identity, never inferred from an arbitrary runner label. */
  distribution: string | null;
  version: string | null;
}

export interface ActionRunnerConfig {
  mode: "container" | "native";
  labels: string[];
  /** Required for container jobs. A runner image with Node and Git installed. */
  image: string | null;
  maxParallel: number;
  cpu: number;
  memoryMb: number;
  /** Persistent destinations only run code approved by their administrators. */
  allowDockerSocket: boolean;
  /** Temporary Cloud worker disk, configured by the operator. */
  cloudDiskGb?: number;
}

export interface ActionNeedsResult {
  result: ActionConclusion;
  outputs: Record<string, string>;
}

export interface ActionJobResult {
  conclusion: ActionConclusion;
  outputs: Record<string, string>;
  steps: Record<string, { outcome: string; conclusion: string }>;
  error?: string;
}

export interface ActionWorkerRequest {
  /** Official GitHub runner; workflow/job credentials come only from GitHub. */
  github?: {
    repository: string;
    name: string;
    token: string;
    labels: string[];
    downloadUrl: string;
    sha256: string;
    image: string;
  };
  version: 1;
  id: string;
  workflow: string;
  workflowPath: string;
  job: string;
  directory: string;
  eventName: string;
  event: Record<string, unknown>;
  actor: string;
  defaultBranch: string;
  matrix: Record<string, unknown>;
  strategy: Record<string, number | boolean>;
  needs: Record<string, ActionNeedsResult>;
  environment: Record<string, string>;
  secrets: Record<string, string>;
  variables: Record<string, string>;
  inputs: Record<string, string>;
  platforms: Record<string, string>;
  timeoutSeconds: number;
  containerCpu: number;
  containerMemoryMb: number;
  /** The selected job platform, resolved from verified destination capabilities. */
  containerPlatform?: ActionContainerPlatform;
  dockerSocket: boolean;
}

export interface ActionWorkerEvent {
  version: 1;
  sequence: number;
  time: string;
  type: "started" | "log" | "result";
  message?: string;
  level?: string;
  step?: string;
  stepId?: string;
  stage?: string;
  stepResult?: string;
  jobResult?: string;
  result?: ActionJobResult;
}

export interface ActionJobDefinition {
  id: string;
  name: string;
  needs: string[];
  runsOn: unknown;
  /** GitHub resolves called workflows; the editor retains their original definition. */
  uses?: string;
  condition?: string | boolean;
  matrix?: unknown;
  failFast: unknown;
  maxParallel: unknown;
  timeoutMinutes: unknown;
  continueOnError: unknown;
  concurrency?: unknown;
  permissions?: unknown;
  environment?: unknown;
  requiresDocker: boolean;
}

export interface ActionWorkflowPlan {
  name: string;
  triggers: Record<string, unknown>;
  jobs: ActionJobDefinition[];
  concurrency?: unknown;
  permissions?: unknown;
}

export interface ActionJobSpec {
  jobId: string;
  name: string;
  matrix: Record<string, unknown>;
  strategy: Record<string, number | boolean>;
  labels: string[];
  needs: Record<string, ActionNeedsResult>;
  timeoutSeconds: number;
  continueOnError: boolean;
  failFast: boolean;
  maxParallel: number;
  concurrency: { group: string; cancelInProgress: boolean } | null;
  permissions: Record<string, "read" | "write">;
  requiresDocker: boolean;
}
