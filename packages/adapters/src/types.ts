/**
 * Shared types used across all adapter layers.
 *
 * These are pure data types - no adapter interfaces here.
 * Resource configs, build/deploy configs, log entries, container info,
 * routing configs, and SSL results.
 */

import type { BuildStrategy, ProxySettings } from "@repo/core";
import type { Readable, Duplex } from "node:stream";
export type { BuildStrategy } from "@repo/core";

// ─── Resource configuration ──────────────────────────────────────────────────

export interface ResourceConfig {
  /** CPU cores (fractional, e.g. 0.5, 1.0, 2.0) - the universal unit all runtimes use */
  cpuCores: number;
  /** Memory limit in megabytes */
  memoryMb: number;
  /** Writable disk in megabytes */
  diskMb: number;
}

/** Single source of truth - production/runtime resources (the free-tier limit).
 *  Deliberately small: a runtime doesn't need build-sized resources, and cloud
 *  runtimes are shrunk to this after the build so they don't hog the pool.
 *  Matches the cloud "low" tier (cloud-resources.ts) so a tier-less / fallback
 *  deploy lands at the same 0.5 vCPU · 512 MB as an explicit free-tier pick. */
export const DEFAULT_RESOURCE_CONFIG: ResourceConfig = {
  cpuCores: 0.5,
  memoryMb: 512,
  diskMb: 5120,
};

/** Single source of truth - build resources. Sized for memory-hungry
 *  production builds (Next.js / webpack routinely need several GB); 4 cores +
 *  8GB is the resource-schema ceiling (project.schema.ts UpdateResourcesBody). */
export const DEFAULT_BUILD_RESOURCE_CONFIG: ResourceConfig = {
  cpuCores: 4,
  memoryMb: 8192,
  diskMb: 10240,
};

/** Normalize a tier's vCPU value for the Oblien workspace payload. Oblien
 *  accepts fractional `cpus`, so the value passes through verbatim — we only
 *  guard the resource-schema floor (0.25) so a 0/negative never reaches the API.
 *  (Previously this ceil'd to a whole integer to work around an Oblien API that
 *  rejected fractions, which over-allocated the 0.25/0.5 tiers to a full core.) */
export function cloudCpus(cpuCores: number): number {
  return Math.max(0.25, cpuCores);
}

// ─── Build / Deploy types ────────────────────────────────────────────────────

export type ContainerStatus =
  | "queued"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "failed"
  | "cancelled"
  /** The runtime has NO record of this container/workspace — it was removed
   *  out-of-band (deleted on the host, or the cloud workspace was destroyed).
   *  Distinct from "stopped" (exists but not running) and from an unreachable
   *  host (which throws). Drives drift detection. */
  | "missing";

export interface BuildConfig {
  /** Unique build session id */
  sessionId: string;
  /** Project identifier */
  projectId: string;
  /** URL slug for the project (e.g. "my-app") */
  slug?: string;
  /** Git repo clone URL (required when source is a git repo) */
  repoUrl: string;
  /** Branch to build */
  branch: string;
  /** Commit SHA (optional, defaults to HEAD) */
  commitSha?: string;
  /** Absolute path to a local project directory (used instead of repoUrl for local projects) */
  localPath?: string;
  /** Where the build runs: "server" (clone/copy to workspace) or "local" (build on host, transfer dist) */
  buildStrategy?: BuildStrategy;
  /**
   * Cloud folder-upload flow: adopt this ALREADY-PROVISIONED cloud workspace
   * instead of creating a fresh one. The browser uploaded the source straight
   * into it, so the build attaches to it and (with `sourceStaged`) skips clone
   * and source transfer. Ignored by non-cloud runtimes.
   */
  cloudWorkspaceId?: string;
  /**
   * Source is ALREADY present at the runtime's project dir (uploaded out of
   * band — the folder-upload flow). Skips both the git clone and the local
   * source transfer; install/build run against what's already there.
   */
  sourceStaged?: boolean;
  /** Detected framework / stack */
  stack: string;
  /** Docker image for the build container (e.g. "node:22", "oven/bun:latest") */
  buildImage: string;
  /** Package manager (npm | yarn | pnpm | bun) */
  packageManager: string;
  /** Shell command to install dependencies */
  installCommand: string;
  /**
   * Monorepo-only: shell command run ONCE at the workspace root after
   * the repo is cloned, before any per-service build runs. Use for any
   * workspace-level prep — install (`pnpm install -w`), codegen
   * (`pnpm prisma generate`), schema sync, etc. Multiple steps chain
   * with `&&`.
   *
   * Optional — leave undefined for single-app builds. Runtime adapters
   * may ignore this when they build each service in an isolated
   * context (Docker per-service builds typically do).
   */
  workspacePrepareCommand?: string;
  /** Shell command to build the project */
  buildCommand: string;
  /** Output directory to collect after build */
  outputDirectory: string;
  /** Port the generated runtime image should listen on. */
  port: number;
  /** Runtime image for generated Docker recipes. */
  runtimeImage: string;
  /** Start command for generated runtime images. */
  startCommand?: string;
  /** Files/directories needed at runtime for generated Docker recipes. */
  productionPaths?: string[];
  /** Root directory within the repo for monorepo builds. */
  rootDirectory?: string;
  /** Explicit Dockerfile path relative to the build root/context. */
  dockerfilePath?: string;
  /** Preloaded Dockerfile contents, used when the caller already read the file from the source provider. */
  dockerfileContent?: string;
  /** Whether the deployment needs a long-running server process. */
  hasServer?: boolean;
  /**
   * Static build served as files: the generated Docker recipe builds the app
   * and serves `outputDirectory` from a minimal web server (SPA fallback to
   * index.html) on `port`, instead of running a `startCommand`. Used for
   * frontend/static monorepo sub-apps (which must be containerized because the
   * monorepo pipeline is container-only).
   */
  isStatic?: boolean;
  /** Environment variables injected at build time */
  envVars: Record<string, string>;
  /** Resources allocated for the build container */
  resources: ResourceConfig;
  /** Ephemeral token for cloning private repos - never persisted */
  gitToken?: string;
  /**
   * Desktop-only: absolute path to a git credential-helper script on the
   * REMOTE build host (written by the deploy git-credential relay). When set,
   * the clone uses this helper (via `GIT_CONFIG_*` env) over a plain URL
   * instead of injecting a token — so no token ever lands in the remote
   * `.git/config`. Mutually exclusive in practice with `gitToken`.
   */
  gitCredentialHelperPath?: string;
  /**
   * SSH clone credential (per-server ssh-server-key / ssh-deploy-key mode). When
   * set, the clone step rewrites the remote to `git@github.com:owner/repo.git`
   * and runs git with `GIT_SSH_COMMAND` pointed at a 0600 key file + pinned
   * known_hosts. No token in the URL. Mutually exclusive with `gitToken` /
   * `gitCredentialHelperPath`.
   */
  gitSsh?: {
    privateKey: string;
    knownHosts: string;
  };
  /**
   * Clone the repo ON the remote build host instead of cloning on the
   * orchestrator and transferring the context. The Docker runtime honors this
   * for SSH (server) builds: it runs `git clone` in a remote host shell (using
   * `gitCredentialHelperPath` when set — the relay — else `gitToken`) into the
   * remote build dir, then builds there. Avoids the download-then-reupload of a
   * large repo. Ignored for local-socket builds and local-path projects.
   */
  cloneOnServer?: boolean;
}

export interface DeployPublicEndpoint {
  port?: number;
  targetPath?: string;
  domain?: string;
  customDomain?: string;
  domainType?: "free" | "custom";
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
  /**
   * Pinned LOOPBACK host port to publish (docker: `127.0.0.1:<hostPort>:<port>`)
   * under the loopback-port route strategy. When unset, docker falls back to a
   * random loopback host port. Ignored by bare (the app owns 127.0.0.1:<port>).
   */
  hostPort?: number;
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
  /** Runtime-safe identifier used for workload/container/page naming. */
  runtimeName?: string;
  /** Authoritative public route mappings for this workload. */
  publicEndpoints?: DeployPublicEndpoint[];
  /** Files/directories to copy into /app/production/ before starting the workload.
   *  When set, the workload runs from /app/production/ instead of /app/. */
  productionPaths?: string[];
  /** Build output directory used for static deployments. */
  outputDirectory?: string;
  /**
   * ID of the project's previously-active deployment, if any. Bare uses
   * this to seed the new release directory as a hard-linked clone of
   * the previous one (Capistrano-style `rsync --link-dest`) — identical
   * files share inodes across releases, which collapses the disk cost
   * of `rollbackWindow` retained versions from O(N × full_size) to
   * O(full_size + small_delta × N). Docker/Cloud ignore the field.
   */
  previousDeploymentId?: string;
  /**
   * Adopt an ALREADY-RUNNING process instead of starting one. When true, a
   * runtime that supports adoption (currently Bare) skips build promotion and
   * the supervisor start entirely — it only health-probes `port` and returns a
   * running result. Used to model an externally-supervised process (e.g. the
   * Openship control plane launched by `openship up`) as a real deployment so
   * the normal routing/SSL pipeline owns it, without a second process binding
   * the port. No-op for runtimes that don't advertise adoption.
   */
  adopt?: boolean;
}

export interface BuildResult {
  sessionId: string;
  status: ContainerStatus;
  /** Opaque reference to the built image / snapshot */
  imageRef?: string;
  durationMs?: number;
  /** Human-readable error description when status is "failed" */
  errorMessage?: string;
  /**
   * Start command chosen BY THE BUILD (overrides the snapshot's when set).
   * The snapshot's startCommand is fixed before the build runs, so a build that
   * only learns the right command after producing output — e.g. detecting a
   * Next.js `output:'standalone'` bundle and switching from `next start` to
   * `node server.js` — reports it here. The orchestrator threads it into the
   * deploy config.
   */
  startCommand?: string;
}

export interface DeploymentResult {
  deploymentId: string;
  containerId?: string;
  url?: string;
  status: ContainerStatus;
}

/**
 * Pipeline step identifiers for stepper UI.
 *
 * "prepare" is one-time server provisioning (toolchain install, source
 * transfer) that runs BEFORE the build timer starts — so it's shown as its own
 * phase and excluded from the reported build duration.
 */
export type BuildStep = "prepare" | "clone" | "install" | "build" | "deploy";

export const BUILD_STEPS: readonly BuildStep[] = ["prepare", "clone", "install", "build", "deploy"] as const;

export interface LogEntry {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
  /** When present, this entry is a step event for the stepper UI */
  step?: BuildStep;
  /** Step lifecycle status */
  stepStatus?: "running" | "completed" | "failed" | "skipped";
  /** Compose service name when this log belongs to one service. */
  serviceName?: string;
  /** Stable id of the service this log belongs to (compose deployments). Routes
   *  the line to its per-service tab without fragile name matching. */
  serviceId?: string;
  /** Pre-encoded base64 data - passed through to SSE without re-encoding. */
  rawData?: string;
  /** Monotonic sequence assigned by the session manager at append time, used as
   *  the SSE event id / client dedup cursor. Decoupled from the ring-buffer
   *  index so it never plateaus when the buffer trims. */
  seq?: number;
}

/**
 * A serialization gate for server/workspace-scoped provisioning. The API injects
 * a concrete implementation (in-process mutex + Postgres advisory lock) so
 * concurrent deploys touching the same server's shared state — apt/dpkg, the
 * openresty unit + shared config, docker networks, the setup-state file — wait
 * for each other instead of racing. Callers wrap the racy critical section in
 * `run`; when no lock is injected, callers fall back to running `fn` directly.
 */
export interface ProvisionLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
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

/** An extra path-prefix location that reverse-proxies to another target. */
export interface RouteProxyLocation {
  /** nginx location prefix, e.g. "/api/". */
  pathPrefix: string;
  /** Proxy target, e.g. "http://10.0.0.5:3000". */
  targetUrl: string;
}

/** A redirect rule compiled from vercel.json `redirects`. */
export interface RouteRedirect {
  /** nginx location path (prefix or exact). */
  path: string;
  /** true → `location = <path>`; false → prefix location. */
  exact: boolean;
  statusCode: number;
  destination: string;
}

/** A response-header rule compiled from vercel.json `headers`. */
export interface RouteHeaderRule {
  path: string;
  headers: { key: string; value: string }[];
}

interface BaseRouteConfig {
  /** External domain (e.g. "my-app.example.com") */
  domain: string;
  /** Whether TLS is enabled */
  tls: boolean;
  /**
   * When set, adds a `/_openship/hooks/` location that proxies
   * webhook requests to the Openship API at this URL.
   * Example: "http://127.0.0.1:4000/api/webhooks/"
   */
  webhookProxy?: string;
  /**
   * Extra path-prefix proxy locations added AHEAD of the primary `location /`
   * (nginx longest-prefix match routes them). Used to compose a Vercel-style
   * single domain: the primary target serves `/` and each entry reverse-proxies
   * a path (e.g. `/api/`) to another service — driven by `vercel.json` rewrites.
   */
  proxyLocations?: RouteProxyLocation[];
  /** Redirect rules (vercel.json `redirects`) → `return <code> <dest>` locations. */
  redirects?: RouteRedirect[];
  /** Response-header rules (vercel.json `headers`) → `add_header`. */
  headerRules?: RouteHeaderRule[];
  /** Curated reverse-proxy tunables (client_max_body_size, proxy/body timeouts,
   *  buffering, gzip) rendered at server scope. Effective merge of the
   *  server default < project < service settings; persists in the route sidecar
   *  so cert re-registration reproduces it. */
  proxy?: ProxySettings;
}

export interface ProxyRouteConfig extends BaseRouteConfig {
  /** Target container IP + port */
  targetUrl: string;
  staticRoot?: never;
}

export interface StaticRouteConfig extends BaseRouteConfig {
  /** Absolute path on the target machine to serve via Nginx root. */
  staticRoot: string;
  targetUrl?: never;
}

export type RouteConfig = ProxyRouteConfig | StaticRouteConfig;

/** An operator-supplied certificate to install verbatim (no ACME). */
export interface ManualCert {
  /** PEM: leaf cert followed by any intermediates (the fullchain). */
  certPem: string;
  /** PEM: the matching private key. */
  keyPem: string;
}

export interface SslResult {
  domain: string;
  /** ISO expiry of the issued cert. Empty when no valid cert was read. */
  expiresAt: string;
  issuer: string;
  /**
   * True only when a real certificate was read and parsed (expiresAt is then
   * valid). When false, `reason` explains why — which lets the persistence
   * layer tell "no cert yet" apart from "transient read failure" and avoid
   * downgrading a healthy `active` domain to `provisioning`.
   */
  verified: boolean;
  reason?: "issued" | "renewed" | "missing" | "read_error";
}

// ─── Log streaming callback ──────────────────────────────────────────────────

export type LogCallback = (entry: LogEntry) => void;

// ─── SSH configuration ──────────────────────────────────────────────────────

/**
 * SSH connection configuration - shared across layers.
 *
 * Used by:
 *   - System layer: execute setup commands on remote servers
 *   - Infra layer: write Nginx config on remote servers
 *   - Platform: wires SSH config to both layers
 *
 * Security:
 *   - Supports private key, SSH agent, or password auth
 *   - Private keys should be encrypted at rest, decrypted in memory
 */
export interface SshConfig {
  host: string;
  port?: number;
  username?: string;
  /** Optional host key verifier for SSH connections. */
  hostVerifier?: (hostKey: Buffer) => boolean;
  /** SSH password for password-based auth */
  password?: string;
  /** Decrypted PEM private key - never stored in plaintext on disk */
  privateKey?: string;
  /** Passphrase for the key (if the PEM itself is encrypted) */
  privateKeyPassphrase?: string;
  /** SSH agent socket (alternative to privateKey) */
  sshAgent?: string;
  /**
   * Route this connection through the OS `ssh` binary (SystemSshExecutor)
   * instead of the in-process `ssh2` client. Set for "agent" auth, where only
   * the real OpenSSH client reliably resolves the agent / `~/.ssh/config` /
   * default keys / keychain. Password and key auth leave this unset.
   */
  useSystemSsh?: boolean;
  /** Optional jump/bastion host (`ssh -J`). Honored by the system-ssh path. */
  sshJumpHost?: string;
  /** Extra raw `ssh` CLI arguments. Honored by the system-ssh path. */
  sshArgs?: string;
}

// ─── Command execution abstraction ──────────────────────────────────────────

/**
 * Abstraction for running commands and file operations on a target machine.
 *
 * Two implementations:
 *   - LocalExecutor  → child_process + fs (same machine)
 *   - SshExecutor    → ssh2 (remote server)
 *
 * Used by the system layer (checks, installers) and infra layer (Nginx
 * config writes) to support both local and remote server management.
 */
export interface CommandExecutor {
  /** Run a command, resolve to stdout. Rejects on non-zero exit. */
  exec(command: string, opts?: { timeout?: number }): Promise<string>;

  /**
   * Run a command with real-time log streaming.
   * Resolves when the command exits - the log callback fires for each line.
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

  /** Remove a file or directory recursively. Silently succeeds if already gone. */
  rm(path: string): Promise<void>;

  /**
   * Transfer a local directory into the target environment.
   *
   * LocalExecutor: cp -a (same filesystem).
   * SshExecutor:   pack the tree into one archive → upload that single file
   *                (ssh2 SFTP, or a cat stream over the OpenSSH ControlMaster)
   *                → verify + extract remotely.
   *
   * By default SshExecutor excludes `node_modules` and `.git` (source transfer).
   * Pass `options.excludes` to override, or `options.includes` to transfer only
   * specific paths (e.g. compiled binaries from productionPaths).
   *
   * Rejects on failure.
   */
  transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: {
      excludes?: string[];
      includes?: string[];
      /** Paths added on top of the git-truth list to ship gitignored build
       *  output (e.g. `.next`). See `TarTransferOptions.alsoInclude`. */
      alsoInclude?: string[];
    },
  ): Promise<void>;

  /** Clean up connections / resources. */
  dispose(): Promise<void>;

  /**
   * Subscribe to transport-level disconnects (socket close/end/error, or a
   * dead ControlMaster). The callback fires with the reason; returns an
   * unsubscribe function. Lets the connection manager react the instant the
   * link drops — reject in-flight ops, reconnect, re-drive journaled work —
   * instead of waiting out per-command timeouts. Implemented by the SSH
   * executors; undefined on LocalExecutor (never disconnects).
   */
  onDisconnect?(cb: (err: Error) => void): () => void;

  /**
   * Run a command and return the raw stdout/stderr streams without
   * line splitting.  Enables byte-for-byte piping of command output.
   *
   * Only available on SshExecutor - local executors do not implement this.
   */
  rawExec?(command: string): Promise<{
    stdout: Readable;
    stderr: Readable;
    onClose: Promise<number>;
    kill: () => void;
  }>;

  /**
   * Open a Unix domain socket tunnel to the target machine.
   *
   * SshExecutor: opens an SSH streamlocal channel on the persistent connection.
   * Not available on LocalExecutor (local Docker uses socket transport directly).
   */
  forwardUnixSocket?(socketPath: string): Promise<Duplex>;

  /**
   * Open a TCP tunnel to a port on the remote machine (SSH direct-tcpip).
   *
   * Returns a duplex stream - write requests, read responses.
   * Not available on LocalExecutor.
   */
  forwardPort?(remoteHost: string, remotePort: number): Promise<Duplex>;

  /**
   * Open an interactive PTY shell on the target machine.
   *
   * Returns a ShellSession with bidirectional byte streams (stdin/stdout/
   * stderr) plus window-resize and exit hooks. The caller is responsible
   * for piping a terminal frontend (e.g. xterm.js over a WebSocket) and
   * calling close() on shutdown.
   *
   * Currently only implemented by SshExecutor (LocalExecutor would need
   * node-pty for parity).
   */
  openShell?(opts?: ShellOptions): Promise<ShellSession>;

  /**
   * Open a REVERSE tunnel: ask the remote to listen on an ephemeral
   * `127.0.0.1` port and forward every connection back to `onConnection`.
   * Used by the git credential relay — a helper on the remote connects to the
   * returned port to fetch a credential on demand — and reusable by any
   * consumer needing a server→host callback path. The caller owns the stream.
   *
   * Implemented by both remote executors: `SshExecutor` (ssh2 `forwardIn`) and
   * `SystemSshExecutor` (`ssh -O forward -R` over the ControlMaster). Absent on
   * `LocalExecutor` (a same-host deploy never needs it).
   */
  reverseForward?(
    onConnection: (stream: Duplex) => void,
  ): Promise<{ port: number; close: () => Promise<void> }>;
}

// ─── Interactive PTY shell ──────────────────────────────────────────────────

export interface ShellOptions {
  /** Initial terminal column count (default 80). */
  cols?: number;
  /** Initial terminal row count (default 24). */
  rows?: number;
  /** TERM env value advertised to the remote shell (default "xterm-256color"). */
  term?: string;
}

/**
 * Live interactive PTY session.
 *
 * Lifecycle:
 *   1. Open via executor.openShell({ cols, rows }).
 *   2. Pipe stdin/stdout/stderr to/from the user-facing transport.
 *   3. Call setWindow(cols, rows) on every terminal resize.
 *   4. Subscribe to onClose to learn when the shell exits.
 *   5. Call close() on teardown - or just wait for the remote shell to
 *      exit. Both paths converge on the same cleanup.
 *
 * The session does NOT auto-reconnect; if the underlying connection
 * drops, the consumer reopens a new shell.
 */
export interface ShellSession {
  /** Writable stream for keystrokes / commands. */
  stdin: import("node:stream").Writable;
  /** Readable byte stream of shell stdout (already interleaved with stderr by the PTY). */
  stdout: import("node:stream").Readable;
  /** Readable byte stream of stderr (typically empty when a PTY is allocated). */
  stderr: import("node:stream").Readable;
  /** Resize the remote PTY window. Safe to call any number of times. */
  setWindow(cols: number, rows: number): void;
  /** Close the session. Best-effort: the underlying channel may already be gone. */
  close(signal?: string): void;
  /** Register a callback fired exactly once when the shell exits. */
  onClose(cb: (code: number | null, signal?: string) => void): void;
}
