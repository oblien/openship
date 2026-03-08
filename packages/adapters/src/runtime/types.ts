/**
 * Runtime adapter interface — build/deploy/observe lifecycle.
 *
 * This is the ONLY concern of the runtime layer: managing containers or
 * processes. Routing, SSL, and system setup are handled by other layers.
 *
 * Three implementations:
 *   - DockerRuntime → Docker Engine via dockerode
 *   - BareRuntime   → Direct processes via child_process
 *   - CloudRuntime  → Oblien cloud API
 */

import type {
  BuildConfig,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
} from "../types";

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Features a runtime may or may not support.
 *
 * Service code checks `runtime.supports("containerInfo")` before calling
 * `runtime.getContainerInfo(...)`. This lets every runtime declare what
 * it actually implements — callers never hit a silent stub.
 */
export type RuntimeCapability =
  | "build"
  | "deploy"
  | "stop"
  | "start"
  | "restart"
  | "destroy"
  | "containerInfo"
  | "runtimeLogs"
  | "usage"
  | "containerIp";

// ─── Interface ───────────────────────────────────────────────────────────────

export interface RuntimeAdapter {
  /** Human-readable name of the runtime */
  readonly name: string;

  /** Set of capabilities this runtime actually implements */
  readonly capabilities: ReadonlySet<RuntimeCapability>;

  /** Check if a specific feature is supported */
  supports(cap: RuntimeCapability): boolean;

  /** Clean up any resources held by the runtime (connections, temp files) */
  dispose?(): Promise<void>;

  // ── Build lifecycle ──────────────────────────────────────────────────

  /**
   * Execute a build (clone repo, install, build).
   * Docker: runs inside an isolated container.
   * Bare: runs on the host via shell commands.
   * Cloud: delegates to cloud build infrastructure.
   */
  build(config: BuildConfig, onLog?: LogCallback): Promise<BuildResult>;

  /** Cancel an in-progress build */
  cancelBuild(sessionId: string): Promise<void>;

  /** Retrieve build logs (for builds that already completed) */
  getBuildLogs(sessionId: string): Promise<LogEntry[]>;

  // ── Deploy lifecycle ─────────────────────────────────────────────────

  /** Start a container/process from a completed build */
  deploy(config: DeployConfig): Promise<DeploymentResult>;

  /** Stop a running container/process (preserves state) */
  stop(containerId: string): Promise<void>;

  /** Start a previously stopped container/process */
  start(containerId: string): Promise<void>;

  /** Restart a container/process */
  restart(containerId: string): Promise<void>;

  /** Permanently remove a container/process and its resources */
  destroy(containerId: string): Promise<void>;

  // ── Observability ────────────────────────────────────────────────────

  /** Get the current status and metadata */
  getContainerInfo(containerId: string): Promise<ContainerInfo>;

  /** Get runtime logs */
  getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]>;

  /** Get current resource usage metrics */
  getUsage(containerId: string): Promise<ResourceUsage>;

  // ── Network ──────────────────────────────────────────────────────────

  /** Resolve the internal IP address of a container/process */
  getContainerIp(containerId: string): Promise<string | null>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Assert that a runtime supports a capability before calling it.
 * Throws a descriptive error if the feature is not available.
 */
export function assertCapability(
  runtime: RuntimeAdapter,
  cap: RuntimeCapability,
): void {
  if (!runtime.supports(cap)) {
    throw new Error(
      `Runtime "${runtime.name}" does not support "${cap}". ` +
        `Supported: ${[...runtime.capabilities].join(", ")}`,
    );
  }
}
