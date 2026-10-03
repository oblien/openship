/**
 * ProcessSupervisor - abstraction over process management strategies.
 *
 * The BareRuntime delegates all process lifecycle operations (deploy,
 * stop, restart, destroy, logs, status) to a supervisor. The supervisor
 * knows HOW to manage processes on the target OS:
 *
 *   SystemdSupervisor → writes unit files, uses systemctl (Linux servers)
 *   NohupSupervisor   → nohup + PID files (macOS dev, fallback)
 *
 * This separation keeps BareRuntime focused on build orchestration
 * while the supervisor handles process lifecycle portably.
 */

import type {
  CommandExecutor,
  LogEntry,
  LogCallback,
  ResourceUsage,
  RuntimeLogStreamOptions,
  ContainerInfo,
} from "../../types";

// ─── Deploy options ──────────────────────────────────────────────────────────

export interface SupervisorDeployOpts {
  /** Unique deployment identifier (used as unit/PID file name) */
  deploymentId: string;
  /** Project identifier */
  projectId: string;
  /** Working directory where the built project lives */
  workDir: string;
  /** Shell command to start the application (e.g. "npm start") */
  startCommand: string;
  /** Port the application listens on */
  port: number;
  /** Declared listeners; an empty list represents a portless worker. */
  ports?: number[];
  /** Environment variables to set for the process */
  env: Record<string, string>;
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface ProcessSupervisor {
  /** Human-readable name (e.g. "systemd", "nohup") */
  readonly name: string;

  /** Start a process managed by this supervisor */
  deploy(opts: SupervisorDeployOpts): Promise<void>;

  /** Stop a running process (graceful → force) */
  stop(deploymentId: string): Promise<void>;

  /** Start a previously stopped process (unit/config must still exist) */
  start(deploymentId: string): Promise<void>;

  /** Whether the saved activation configuration can restart this process. */
  canStart(deploymentId: string): Promise<boolean>;

  /** Restart a process (stop + start with same config) */
  restart(deploymentId: string): Promise<void>;

  /** Permanently remove a process and all its managed resources */
  destroy(deploymentId: string): Promise<void>;

  /** Check if the process is currently running */
  isRunning(deploymentId: string): Promise<boolean>;

  /** Detailed state and owned listeners, when supplied by the host's process manager. */
  getInfo?(deploymentId: string): Promise<ContainerInfo>;

  /** Authoritative project inventory, including stopped and failed releases. */
  listProjectDeploymentIds?(projectId: string): Promise<string[]>;

  /** Release log subscriptions owned by this runtime borrower. */
  dispose?(): Promise<void>;

  /**
   * Current CPU / memory / disk-IO for the process.
   *
   * Both supervisors implement it via the shared `sampleBareUsage` probe (cgroup →
   * /proc → ps), since the measurement depends on the OS rather than on how the
   * process was started. Returns zeros for a process that isn't running.
   *
   * `networkRxBytes`/`networkTxBytes` are always 0: per-process network accounting
   * needs eBPF or a dedicated netns, which a bare deploy has neither of.
   */
  getUsage(deploymentId: string): Promise<ResourceUsage>;

  /** Get recent log lines */
  getLogs(deploymentId: string, tail?: number): Promise<LogEntry[]>;

  /** Stream logs in real-time. Returns a cleanup function. */
  streamLogs(
    deploymentId: string,
    onLog: LogCallback,
    opts?: RuntimeLogStreamOptions,
  ): Promise<() => void>;
}

// ─── Factory helper type ─────────────────────────────────────────────────────

export interface SupervisorFactory {
  (executor: CommandExecutor, workDir: string): Promise<ProcessSupervisor>;
}
