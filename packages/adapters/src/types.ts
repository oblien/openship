/**
 * Shared types used across all adapter layers.
 *
 * These are pure data types — no adapter interfaces here.
 * Resource configs, build/deploy configs, log entries, container info,
 * routing configs, and SSL results.
 */

// ─── Resource configuration ──────────────────────────────────────────────────

export interface ResourceConfig {
  /** CPU cores (fractional, e.g. 0.5, 1.0, 2.0) — the universal unit all runtimes use */
  cpuCores: number;
  /** Memory limit in megabytes */
  memoryMb: number;
  /** Writable disk in megabytes */
  diskMb: number;
}

/** Single source of truth — production resources */
export const DEFAULT_RESOURCE_CONFIG: ResourceConfig = {
  cpuCores: 1,
  memoryMb: 512,
  diskMb: 4096,
};

/** Single source of truth — build resources */
export const DEFAULT_BUILD_RESOURCE_CONFIG: ResourceConfig = {
  cpuCores: 2,
  memoryMb: 4096,
  diskMb: 10240,
};

// ─── Build / Deploy types ────────────────────────────────────────────────────

export type ContainerStatus =
  | "queued"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "failed"
  | "cancelled";

export interface BuildConfig {
  /** Unique build session id */
  sessionId: string;
  /** Project identifier */
  projectId: string;
  /** Git repo clone URL */
  repoUrl: string;
  /** Branch to build */
  branch: string;
  /** Commit SHA (optional, defaults to HEAD) */
  commitSha?: string;
  /** Detected framework / stack */
  stack: string;
  /** Docker image for the build container (e.g. "node:22", "oven/bun:latest") */
  buildImage: string;
  /** Package manager (npm | yarn | pnpm | bun) */
  packageManager: string;
  /** Shell command to install dependencies */
  installCommand: string;
  /** Shell command to build the project */
  buildCommand: string;
  /** Output directory to collect after build */
  outputDirectory: string;
  /** Environment variables injected at build time */
  envVars: Record<string, string>;
  /** Resources allocated for the build container */
  resources: ResourceConfig;
  /** Ephemeral token for cloning private repos — never persisted */
  gitToken?: string;
}

export interface DeployConfig {
  /** Unique deployment id */
  deploymentId: string;
  /** Project identifier */
  projectId: string;
  /** Reference to the completed build session */
  buildSessionId: string;
  /** Opaque reference to the built artifact (workspace ID, docker image tag, etc.) */
  imageRef?: string;
  /** "production" | "preview" */
  environment: string;
  /** Port the application listens on */
  port: number;
  /** Shell command to start the application (e.g. "npm start", "node server.js") */
  startCommand?: string;
  /** Detected framework / stack (e.g. "nextjs", "express") */
  stack?: string;
  /** Environment variables injected at runtime */
  envVars: Record<string, string>;
  /** Resources allocated for the production container */
  resources: ResourceConfig;
  /** Container restart policy */
  restartPolicy?: "always" | "on-failure" | "no";
  /** URL slug for the deployment (e.g. "my-app" → my-app.opsh.io) */
  slug?: string;
  /** Custom domain to bind via DNS (e.g. "app.example.com") — separate from free subdomain */
  customDomain?: string;
}

export interface BuildResult {
  sessionId: string;
  status: ContainerStatus;
  /** Opaque reference to the built image / snapshot */
  imageRef?: string;
  durationMs?: number;
}

export interface DeploymentResult {
  deploymentId: string;
  containerId?: string;
  url?: string;
  status: ContainerStatus;
}

/** Pipeline step identifiers for stepper UI */
export type BuildStep = "clone" | "install" | "build" | "deploy";

export const BUILD_STEPS: readonly BuildStep[] = ["clone", "install", "build", "deploy"] as const;

export interface LogEntry {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
  /** When present, this entry is a step event for the stepper UI */
  step?: BuildStep;
  /** Step lifecycle status */
  stepStatus?: "running" | "completed" | "failed" | "skipped";
  /** Pre-encoded base64 data — passed through to SSE without re-encoding. */
  rawData?: string;
}

export interface ContainerInfo {
  containerId: string;
  status: ContainerStatus;
  /** Container IP on the internal network */
  ip?: string;
  /** Mapped port on host (if applicable) */
  hostPort?: number;
  /** Uptime in seconds */
  uptimeSeconds?: number;
  /** Current resource consumption */
  usage?: ResourceUsage;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMb: number;
  diskMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface RouteConfig {
  /** External domain (e.g. "my-app.example.com") */
  domain: string;
  /** Target container IP + port */
  targetUrl: string;
  /** Whether TLS is enabled */
  tls: boolean;
}

export interface SslResult {
  domain: string;
  expiresAt: string;
  issuer: string;
}

// ─── Log streaming callback ──────────────────────────────────────────────────

export type LogCallback = (entry: LogEntry) => void;

// ─── SSH configuration ──────────────────────────────────────────────────────

/**
 * SSH connection configuration — shared across layers.
 *
 * Used by:
 *   - System layer: execute setup commands on remote servers
 *   - Infra layer: write Traefik config on remote servers
 *   - Platform: wires SSH config to both layers
 *
 * Security:
 *   - Key-based auth ONLY (no password)
 *   - Private keys should be encrypted at rest, decrypted in memory
 */
export interface SshConfig {
  host: string;
  port?: number;
  username?: string;
  /** Decrypted PEM private key — never stored in plaintext on disk */
  privateKey?: string;
  /** Passphrase for the key (if the PEM itself is encrypted) */
  privateKeyPassphrase?: string;
  /** SSH agent socket (alternative to privateKey) */
  sshAgent?: string;
}

// ─── Command execution abstraction ──────────────────────────────────────────

/**
 * Abstraction for running commands and file operations on a target machine.
 *
 * Two implementations:
 *   - LocalExecutor  → child_process + fs (same machine)
 *   - SshExecutor    → ssh2 (remote server)
 *
 * Used by the system layer (checks, installers) and infra layer (Traefik
 * config writes) to support both local and remote server management.
 */
export interface CommandExecutor {
  /** Run a command, resolve to stdout. Rejects on non-zero exit. */
  exec(command: string, opts?: { timeout?: number }): Promise<string>;

  /**
   * Run a command with real-time log streaming.
   * Resolves when the command exits — the log callback fires for each line.
   */
  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }>;

  /** Write content to a file on the target machine. Creates dirs as needed. */
  writeFile(path: string, content: string): Promise<void>;

  /** Read a file from the target machine. */
  readFile(path: string): Promise<string>;

  /** Check if a file or directory exists. */
  exists(path: string): Promise<boolean>;

  /** Create a directory (recursive). */
  mkdir(path: string): Promise<void>;

  /** Remove a file. Silently succeeds if already gone. */
  rm(path: string): Promise<void>;

  /** Clean up connections / resources. */
  dispose(): Promise<void>;
}
