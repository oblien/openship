/**
 * Runtime adapter interface - build/deploy/observe lifecycle.
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
  ContainerStatus,
  ResourceUsage,
  ResourceConfig,
  ShellOptions,
  ShellSession,
} from "../types";
import type { ComposeAdvanced } from "@repo/core";
import type { BuildLogger } from "./build-pipeline";
import type { PortProbeExecutor } from "../system/port-listen";

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Features a runtime may or may not support.
 *
 * Service code checks `runtime.supports("containerInfo")` before calling
 * `runtime.getContainerInfo(...)`. This lets every runtime declare what
 * it actually implements - callers never hit a silent stub.
 */
export type RuntimeCapability =
  | "build"
  | "deploy"
  | "multiServiceDeploy"
  | "stop"
  | "start"
  | "restart"
  | "destroy"
  | "containerInfo"
  | "runtimeLogs"
  | "streamLogs"
  | "usage"
  | "containerIp"
  /**
   * Runtime exposes the rollback primitives (`makeActive`, `archive`,
   * `purge`). When unsupported, rollback is unavailable for projects
   * deploying to this runtime. All in-tree runtimes support this.
   */
  | "rollback"
  /**
   * Runtime can open an interactive PTY shell INSIDE a deployed
   * service's container/workspace. Docker exec with TTY, Oblien
   * workspace terminal, etc. Powers the in-dashboard service
   * terminal — see modules/service-terminal/.
   */
  | "serviceShell"
  /**
   * Runtime can enumerate every container it owns for a given project
   * by label, independent of DB tracking. Powers the project-deletion
   * orphan sweep: a container started by a deploy that later failed (or
   * whose row was lost) has no DB record, but it still carries the
   * `openship.project=<id>` label — so teardown can reclaim it. Docker
   * implements this; Bare/Cloud don't (no label-queryable container set).
   */
  | "projectContainerSweep"
  /**
   * Runtime can enumerate the containers for a specific DEPLOYMENT by its
   * `openship.deployment=<id>` label and report their live state. Powers
   * reconciliation: after a connection-loss deploy, we read back what's
   * actually running to resolve `reconciling` → ready/failed and detect
   * drift. Docker implements this; Bare/Cloud don't (no label-queryable set)
   * and reconcile falls back to per-container `getContainerInfo`.
   */
  | "deploymentContainerQuery"
  /**
   * Runtime can hand back a command runner that executes INSIDE a running
   * deployment (not on the build/daemon host). Powers the advisory post-deploy
   * port probe (`cat /proc/net/tcp*`). Docker exec (Tty:false), Oblien workspace
   * exec, or — for Bare — the host executor itself (the process shares the host
   * netns). Capability flag: "inContainerExec".
   */
  | "inContainerExec";

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
  build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult>;

  /** Cancel an in-progress build */
  cancelBuild(sessionId: string): Promise<void>;

  /** Retrieve build logs (for builds that already completed) */
  getBuildLogs(sessionId: string): Promise<LogEntry[]>;

  // ── Deploy lifecycle ─────────────────────────────────────────────────

  /** Start a container/process from a completed build */
  deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult>;

  /** Stop a running container/process (preserves state) */
  stop(containerId: string): Promise<void>;

  /** Start a previously stopped container/process */
  start(containerId: string): Promise<void>;

  /** Restart a container/process */
  restart(containerId: string): Promise<void>;

  /** Permanently remove a container/process and its resources */
  destroy(containerId: string): Promise<void>;

  /**
   * List the IDs of every container this runtime owns for `projectId`,
   * matched by the `openship.project` label (includes stopped ones).
   * Used by project teardown to reclaim orphans with no DB row. Only
   * present when `supports("projectContainerSweep")`.
   */
  listProjectContainerIds?(projectId: string): Promise<string[]>;

  /**
   * List the containers this runtime owns for `deploymentId`, matched by the
   * `openship.deployment` label, with their live status + service name. Used
   * by reconciliation to read back the true state of a connection-loss deploy.
   * Only present when `supports("deploymentContainerQuery")`.
   */
  listDeploymentContainers?(
    deploymentId: string,
  ): Promise<Array<{ containerId: string; status: ContainerStatus; serviceName?: string }>>;

  // ── Observability ────────────────────────────────────────────────────

  /** Get the current status and metadata */
  getContainerInfo(containerId: string): Promise<ContainerInfo>;

  /** Get runtime logs */
  getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]>;

  /**
   * Stream runtime logs in real-time via callback.
   * Returns a cleanup function to stop the stream.
   */
  streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void>;

  /** Get current resource usage metrics */
  getUsage(containerId: string): Promise<ResourceUsage>;

  // ── Network ──────────────────────────────────────────────────────────

  /** Resolve the internal IP address of a container/process */
  getContainerIp(containerId: string): Promise<string | null>;

  /**
   * Hand back a command runner scoped to the INSIDE of the running deployment
   * named by `containerId` (docker container / cloud workspace / bare host
   * netns). Its `.exec` runs `sh -c <cmd>` in that context — used by the
   * advisory post-deploy port probe. Optional; callers skip the probe when the
   * runtime doesn't implement it (capability "inContainerExec").
   *
   * NOTE: on Bare this is the host executor, so a probe sees EVERY listener on
   * the host, not only this deployment's — fine for an advisory "is something on
   * this port?" but not proof it's this specific process.
   */
  inContainerExecutor?(containerId: string): Promise<PortProbeExecutor>;

  /**
   * Attach this project's containers to additional networks (by name) — for
   * cross-project service links, so a consumer joins a linked database app's
   * `openship-<slug>` network and resolves its service alias with no public
   * port. Best-effort + idempotent. Optional (docker only; cloud/bare skip —
   * cloud uses public host:port, its private-link mesh is group-scoped).
   */
  attachToExternalNetworks?(projectId: string, networkNames: string[]): Promise<void>;

  // ── Rollback primitives ──────────────────────────────────────────────
  //
  // Three atomic ops the RollbackOrchestrator composes into "deploy
  // landed: archive prev + activate new", "user rolled back: archive
  // current + makeActive target", and "retention overflowed: purge".
  // Each runtime implements them differently:
  //   Docker — container start/stop + image tag retention + rmi
  //   Bare   — release-dir symlink swap + service reload + rm -rf
  //   Cloud  — workspace launch from archived disk + archive disk + delete
  //
  // Capability flag: "rollback". Service code calls assertCapability
  // before using; runtimes without rollback raise at deploy preflight
  // rather than mid-flight.
  //
  // ALL ops are idempotent: calling makeActive on an already-active
  // deployment is a no-op; archiving an already-archived one is too;
  // purging an already-purged one is too.

  /**
   * Make this deployment the live one. Handles the transition from
   * whatever was active before — the orchestrator passes the previous
   * active as `from` so the runtime can stop / archive it as part of
   * the same swap (avoids brief "nothing active" windows).
   *
   * Used by:
   *   - Rollback (artifact already archived, we restore it)
   *   - Re-promotion (rare: a paused/archived dep is brought back)
   *
   * NOT used by the initial deploy path — that's `deploy()` which
   * builds-then-activates atomically.
   *
   * Returns identifiers the orchestrator needs to persist on the
   * deployment row (newly-created container ID for Docker if we ran
   * from image, new workspace ID for Cloud, etc.).
   */
  makeActive(input: RollbackInput): Promise<MakeActiveResult>;

  /**
   * Preserve this deployment's artifact in non-active state so it can
   * be made active later. Idempotent.
   *   Docker — `docker stop` (image stays tagged, container preserved)
   *   Bare   — no-op (release dir already on disk = archived)
   *   Cloud  — `snapshots.createArchive` + `workspace.stop` (disk
   *            captured as point-in-time archive next to the workspace;
   *            compute paused).
   */
  archive(deployment: DeploymentRef): Promise<void>;

  /**
   * Destroy this deployment's artifact. Past this point rollback is
   * impossible — the orchestrator only calls this on retention
   * overflow + unpinned deployments. Idempotent.
   *   Docker — `docker rm` + `docker rmi`
   *   Bare   — `rm -rf releases/<id>`
   *   Cloud  — delete archived disk
   */
  purge(deployment: DeploymentRef): Promise<void>;

  // ── Interactive service shell ────────────────────────────────────────
  //
  // Opens a PTY-attached shell INSIDE the deployed service. Powers the
  // in-dashboard service terminal. Capability flag: "serviceShell".
  //
  //   Docker — `docker exec -ti <containerId> /bin/sh -c '...'`
  //   Bare   — currently unsupported (would need node-pty + chroot)
  //   Cloud  — `rt.terminal.create({shell})` + multiplexed WS bridge
  //
  // The `containerId` parameter is whatever the deployment row stored
  // as its container/workspace identifier. The caller resolves
  // service → container before calling. The returned ShellSession
  // exposes the same stdin/stdout/setWindow/onClose shape as
  // SshExecutor.openShell, so the WS bridge code is identical.

  /**
   * Open an interactive shell inside a deployed service. Optional —
   * runtimes without `serviceShell` capability throw if called.
   */
  openServiceShell?(
    containerId: string,
    opts?: ShellOptions,
  ): Promise<ShellSession>;
}

// ─── Rollback primitive types ───────────────────────────────────────────────

/** Minimal deployment shape the rollback primitives need. Keeps the
 *  adapter layer free of DB-row dependencies — the orchestrator maps
 *  Deployment → DeploymentRef before each call. */
export interface DeploymentRef {
  id: string;
  projectId: string;
  /** Build artifact reference produced at deploy time. For Docker: image
   *  tag. For Bare: release dir path. For Cloud: archived disk ref. */
  imageRef: string | null;
  /** Active container/process/workspace ID, if one exists. May be null
   *  on archived deployments (Docker container could be GC'd, Bare
   *  doesn't track one, Cloud terminated its workspace). */
  containerId: string | null;
  /** Per-service container IDs for multi-service compose deployments.
   *  Empty for single-service. */
  serviceContainerIds?: Record<string, string>;
}

export interface RollbackInput {
  /** Currently active deployment to be archived as part of the swap.
   *  Null when no deployment is currently active (first deploy
   *  re-activation, recovery from a failed state, etc.). */
  from: DeploymentRef | null;
  /** Target deployment to be made active. The orchestrator validates
   *  that this deployment's artifact is archived (rollback-restorable)
   *  before invoking the runtime. */
  to: DeploymentRef;
}

export interface MakeActiveResult {
  /** New container ID if the runtime created one (Docker `run` from
   *  image when the previous container was GC'd). Undefined when no
   *  ID change happened (existing container started, Bare symlink
   *  swap, etc.). */
  containerId?: string;
  /** New URL if the runtime assigned one (Cloud launches new
   *  workspace at fresh URL). Undefined when the URL is stable. */
  url?: string;
  /** New per-service container IDs for multi-service deployments. */
  serviceContainerIds?: Record<string, string>;
}

export interface MultiServiceGroupHandle {
  /** Opaque runtime-specific group identifier (network ID, workspace ID, etc.) */
  id: string;
}

export interface MultiServiceDeployConfig {
  deploymentId: string;
  projectId: string;
  slug: string;
  serviceName: string;
  image: string;
  ports: string[];
  environment: Record<string, string>;
  volumes: string[];
  /** When true, NAMED volumes are project-scoped (openship-<slug>-<name>) at
   *  create time. False for grandfathered pre-migration services (bare names). */
  namespaceVolumes: boolean;
  command?: string;
  restart?: string;
  /**
   * Force a fresh `docker pull` of the image tag even when a local copy exists.
   * Set only for the "update" trigger — a normal deploy/redeploy stays
   * pull-if-missing so it never surprise-bumps a `:latest` app or defeats the
   * unchanged-image carry-forward.
   */
  forcePull?: boolean;
  /** Extended compose fields (healthcheck, …). Docker honors them; runtimes
   *  that can't (cloud) warn-and-drop. See ComposeAdvanced in @repo/core. */
  advanced?: ComposeAdvanced;
  resources?: { cpuCores?: number; memoryMb?: number };
  publicPort?: number;
  publicSlug?: string;
  customDomain?: string;
  expose?: boolean;
  /** Cloud only: the workspace id this service used in the PREVIOUS deployment.
   *  Reused so its permanent-workspace disk — the only persistence Oblien
   *  offers (no volume primitive) — survives a redeploy. A fresh workspace each
   *  deploy = silent data loss for stateful services (Postgres, Redis, …). */
  previousWorkspaceId?: string;
  /** Service names this service depends on (compose `depends_on`). Used for
   *  readiness ordering on runtimes with no native healthcheck. */
  dependsOn?: string[];
}

export interface MultiServiceDeployResult {
  containerId: string;
  status: string;
  ip?: string;
  hostPort?: number;
  /**
   * Content-addressable image digest actually running (`repo@sha256:…`), read
   * from the image's RepoDigests after create. The anchor the update scanner
   * uses to detect a moved mutable tag. Undefined when unresolvable (e.g. a
   * locally-built image with no registry digest).
   */
  imageDigest?: string;
}

export interface MultiServiceRuntimeAdapter extends RuntimeAdapter {
  readonly capabilities: ReadonlySet<RuntimeCapability>;

  /**
   * Extended compose keys (from `service.advanced`) this runtime cannot honor.
   * The compose deploy service warns once per service for any requested key in
   * this set and drops it — never fails — so a docker-authored compose file
   * still deploys elsewhere, just without the host-level extras. Empty = honors
   * everything it's given (the Docker runtime).
   */
  readonly unsupportedComposeKeys: ReadonlySet<keyof ComposeAdvanced>;

  /** Prepare shared runtime state for sibling services (network, workspace, mesh, etc.) */
  ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
    resources?: ResourceConfig;
  }): Promise<MultiServiceGroupHandle>;

  /** Deploy one service workload into a prepared group */
  deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult>;

  /**
   * Optional batch build: clone/prune the shared source ONCE and build every
   * image from it (transferring once for SSH). Implemented by runtimes where all
   * services build on the same daemon/host (Docker), so the repo isn't re-cloned
   * per service. Absent on runtimes where each service is a separate instance
   * (Cloud) — those keep building per-service via `build()`. Prepare-phase logs
   * (clone/transfer) go to `prepareLogger`; each image's output to `spec.logger`.
   */
  buildImages?(
    specs: Array<{
      config: BuildConfig;
      serviceName: string;
      logger: BuildLogger;
      requireRepositoryDockerfile?: boolean;
      /** Called when THIS image's build begins (after the shared clone/
       *  transfer) so callers can flip the service to "building" only then. */
      onStart?: () => void;
      /** Called with THIS image's result the moment its build settles, so
       *  callers can record/broadcast per service as each finishes (builds run
       *  sequentially) rather than waiting for the whole batch. */
      onResult?: (result: BuildResult) => void;
    }>,
    prepareLogger: BuildLogger,
  ): Promise<Array<{ serviceName: string; result: BuildResult }>>;

  /**
   * Optional final convergence pass, run ONCE after every service in the group
   * has deployed. Lets a runtime whose service discovery is built up
   * incrementally (Cloud: per-workspace /etc/hosts + private links) re-resolve
   * any late-assigned addresses and rewrite the full mesh so every peer is
   * reachable by name. Absent on runtimes with live DNS (Docker) — their real
   * network needs no post-pass.
   */
  finalizeServiceGroup?(
    group: MultiServiceGroupHandle,
    onLog?: LogCallback,
  ): Promise<void>;

  /**
   * Optional: seed an ALREADY-RUNNING service into the group's in-memory mesh
   * state WITHOUT deploying it, so a subsequent `finalizeServiceGroup` includes
   * it when rewriting the full mesh. Used by the decoupled single-service add
   * (strictScope): only the new service is deployed, but its existing peers
   * must stay reachable by name (and learn about the newcomer). No-op / absent
   * on runtimes with live DNS (Docker) — their real network needs no seeding.
   */
  registerExistingWorkload?(
    group: MultiServiceGroupHandle,
    service: { serviceName: string; workspaceId: string; ip?: string; portSpecs?: string[] },
  ): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Assert that a runtime supports a capability before calling it.
 * Throws a descriptive error if the feature is not available.
 */
export function assertCapability(runtime: RuntimeAdapter, cap: RuntimeCapability): void {
  if (!runtime.supports(cap)) {
    throw new Error(
      `Runtime "${runtime.name}" does not support "${cap}". ` +
        `Supported: ${[...runtime.capabilities].join(", ")}`,
    );
  }
}

export function isMultiServiceRuntime(
  runtime: RuntimeAdapter,
): runtime is MultiServiceRuntimeAdapter {
  return runtime.supports("multiServiceDeploy");
}

// ─── Docker discovery (label-agnostic inspection) ─────────────────────────────
//
// DTOs for MIGRATING an existing Docker deployment into Openship. The
// label-scoped queries elsewhere in DockerRuntime only see `openship.*`
// containers; these enumerate the WHOLE daemon so we can adopt containers
// Openship never created (a hand-run `docker run`, or a `docker compose` stack).
// All fields are plain/serializable — they cross the API→dashboard boundary.

export interface DockerMount {
  /** "volume" | "bind" | "tmpfs" | "npipe" */
  type: string;
  /** Named-volume name (type=volume). Absent for binds/tmpfs. */
  name?: string;
  /** Host path (bind) or the volume's resolved mountpoint. */
  source?: string;
  /** Path inside the container. */
  destination: string;
  rw: boolean;
}

export interface DockerPortBinding {
  /** Container-side port. */
  privatePort: number;
  /** Published host port (absent = exposed but not published). */
  publicPort?: number;
  /** "tcp" | "udp" | "sctp" */
  type: string;
  /** Host IP the port is bound on ("0.0.0.0" = all interfaces). */
  ip?: string;
}

/** One container as seen in the `docker ps` list view. */
export interface DockerContainerSummary {
  id: string;
  names: string[];
  image: string;
  imageId: string;
  /** "running" | "exited" | "paused" | "created" | "restarting" | "dead" */
  state: string;
  /** Human status line, e.g. "Up 3 days". */
  status: string;
  labels: Record<string, string>;
  ports: DockerPortBinding[];
  mounts: DockerMount[];
  /** com.docker.compose.project label, if the container is compose-managed. */
  composeProject?: string;
  /** com.docker.compose.service label, if the container is compose-managed. */
  composeService?: string;
}

/** Full `docker inspect` of one container, normalized to what adoption needs. */
export interface DockerContainerDetail {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  command?: string[];
  entrypoint?: string[];
  /** Config.Env as raw KEY=VALUE strings (image-default entries included). */
  env: string[];
  workingDir?: string;
  labels: Record<string, string>;
  restart?: { name: string; maximumRetryCount?: number };
  /** Names of the networks the container is attached to. */
  networks: string[];
  mounts: DockerMount[];
  ports: DockerPortBinding[];
  /** Healthcheck as declared on the container config (durations in ns). */
  healthcheck?: {
    test?: string[];
    interval?: number;
    timeout?: number;
    retries?: number;
    startPeriod?: number;
  };
  composeProject?: string;
  composeService?: string;
  /** com.docker.compose.project.config_files — absolute compose paths on the host. */
  composeConfigFiles?: string[];
  /** com.docker.compose.project.working_dir — the compose project's cwd. */
  composeWorkingDir?: string;
}

export interface DockerVolumeInfo {
  name: string;
  driver: string;
  mountpoint?: string;
  labels: Record<string, string>;
  composeProject?: string;
}

export interface DockerNetworkInfo {
  id: string;
  name: string;
  driver: string;
  labels: Record<string, string>;
  composeProject?: string;
}
