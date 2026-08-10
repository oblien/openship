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
import type { ContainerStabilitySample } from "./stability";

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
   * Runtime participates in artifact RETENTION — it implements `archive`
   * and `purge`, so the rollback orchestrator can preserve a past
   * deployment's artifact and reclaim it on retention overflow. All
   * in-tree runtimes support this.
   */
  | "rollback"
  /**
   * Runtime's artifact is a durable PER-DEPLOYMENT UNIT that survives a
   * redeploy and can be restarted in place, so it implements
   * `makeActive` and rollback is a genuine instant unit swap.
   *
   * Bare (supervisor unit + release dir) and Cloud (stopped workspace +
   * disk) have this. Docker does NOT: a redeploy removes the previous
   * container, so its restore re-materializes from the retained image
   * through the normal deploy step instead.
   */
  | "unitRestore"
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
   * Runtime can enumerate EVERY container on its host, label-agnostic, with
   * live state — `docker ps -a`. Unlike `deploymentContainerQuery` this is not
   * scoped by an `openship.*` label, which is exactly why the live service-state
   * read needs it: a migration-attached container keeps its ORIGINAL labels
   * (immutable in place), so a label-filtered query can never see it. Docker
   * implements this; Cloud/Bare don't (no host container set).
   */
  | "hostContainerQuery"
  /**
   * Runtime can hand back a command runner that executes INSIDE a running
   * deployment (not on the build/daemon host). Powers the advisory post-deploy
   * port probe (`cat /proc/net/tcp*`). Docker exec (Tty:false), Oblien workspace
   * exec, or — for Bare — the host executor itself (the process shares the host
   * netns). Capability flag: "inContainerExec".
   */
  | "inContainerExec"
  /**
   * Runtime can report a container's RESTART HISTORY and health, not just a
   * point-in-time status — the readings the post-deploy stabilization watch
   * needs to tell "up" from "bouncing" (`sampleStability`). Docker implements
   * it; Cloud/Bare expose no restart counter, so their deploys skip the watch.
   */
  | "stabilityProbe"
  /**
   * Runtime can push container lifecycle TRANSITIONS as they happen
   * (`watchContainerEvents` — Docker's `/events`). This only ever *accelerates*
   * a state read: the stream is edge-triggered, so a dropped connection or a
   * daemon restart loses transitions forever, and a container that never
   * changes (stuck in `created`, down before we connected) emits nothing at
   * all. Consumers therefore keep polling and use an event as "read state now"
   * — see modules/monitoring/container-events.ts. Docker implements it;
   * Cloud/Bare have no event feed.
   */
  | "containerEvents";

// ─── Events ──────────────────────────────────────────────────────────────────

/** One container lifecycle transition, normalized away from Docker's wire shape. */
export interface ContainerLifecycleEvent {
  containerId: string;
  /**
   * Docker's `Action`, normalized. Both healthcheck edges are carried —
   * `health_status: unhealthy` → "unhealthy", `health_status: healthy` →
   * "healthy" — because a healthcheck recovery emits no other event: the
   * container never stopped, so there is no `start` to notice it by.
   * `health_status: starting` is dropped at the source.
   */
  action:
    | "die"
    | "oom"
    | "kill"
    | "stop"
    | "restart"
    | "start"
    | "unhealthy"
    | "healthy"
    | "destroy";
  /** Event time in whole seconds, as the daemon reported it. */
  atSeconds: number;
}

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

  /**
   * Every container on this runtime's host (running or not), label-agnostic —
   * the raw `docker ps -a` view. The live service-state read matches these
   * against the project's service rows by identity (labels, container name,
   * tracked id), so a container Openship adopted in place — carrying another
   * project's labels — still reports its true state. Only present when
   * `supports("hostContainerQuery")`.
   */
  listAllContainers?(): Promise<DockerContainerSummary[]>;

  // ── Observability ────────────────────────────────────────────────────

  /** Get the current status and metadata */
  getContainerInfo(containerId: string): Promise<ContainerInfo>;

  /**
   * One stabilization reading: restart count, last exit code, healthcheck
   * verdict, current uptime. `getContainerInfo` cannot answer this — it maps
   * `restarting` onto `running` on purpose, so a crash-looping container reads
   * as healthy there. Returns a `missing` sample when the container is gone.
   * Only present when `supports("stabilityProbe")`; the post-deploy watch is
   * skipped for runtimes without it.
   */
  sampleStability?(containerId: string): Promise<ContainerStabilitySample>;

  /**
   * Subscribe to container lifecycle transitions on this host, host-wide and
   * label-agnostic (the consumer maps ids → projects itself). Returns a cleanup
   * function, same convention as `streamRuntimeLogs`.
   *
   * The stream carries TRANSITIONS, never state — so it is an accelerator for a
   * poll, not a replacement (see the `containerEvents` capability doc). The
   * runtime deliberately does NOT reconnect on its own: only the caller knows
   * whether the subscription is still wanted, and it must treat every
   * (re)connect as a reason to re-read state anyway. Only present when
   * `supports("containerEvents")`.
   */
  watchContainerEvents?(handlers: {
    onEvent: (event: ContainerLifecycleEvent) => void;
    /**
     * The stream ended. `null` = clean EOF, otherwise the transport error.
     * Fires at most once per subscription, and not at all after cleanup.
     */
    onClose: (err: Error | null) => void;
  }): Promise<() => void>;

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

  /**
   * Join already-running containers (migration attach-live reuse) to a project's
   * `openship-<slug>` network with a DNS alias each, so a natively-deployed
   * service in the SAME project resolves them by name (reused `postgres` reachable
   * from a freshly-built `web`). Additive network-connect — no restart, no volume
   * touch. Best-effort + idempotent. Optional (docker only). */
  joinServiceGroupContainers?(
    slug: string,
    members: Array<{ containerId: string; alias: string }>,
  ): Promise<void>;

  // ── Rollback primitives ──────────────────────────────────────────────
  //
  // What "the artifact" IS differs per runtime, and that difference is
  // the whole design:
  //
  //   Bare / Cloud — a DURABLE PER-DEPLOYMENT UNIT (supervisor unit +
  //     release dir; stopped workspace + disk). It survives a redeploy,
  //     so restoring it really is an instant swap: `makeActive`.
  //     Capability flag: "unitRestore".
  //
  //   Docker — the IMAGE. Containers are disposable and a redeploy
  //     REMOVES the previous one (the loopback-port route strategy can't
  //     overlap two containers on one host port), so there is no unit to
  //     restart. Docker therefore does NOT implement `makeActive`; its
  //     restore re-materializes the container from the retained image
  //     through the normal deploy step, with the target's frozen config
  //     snapshot + env (see modules/deployments/rollback/restore-plan.ts).
  //     A hand-rolled `createContainer` here can only ever be a
  //     lesser copy of `deploy()` — that's exactly the stub that shipped
  //     rollbacks with no env, no published port and detached volumes.
  //
  // `archive`/`purge` are the RETENTION half and every runtime
  // implements them (capability flag: "rollback").
  //
  // ALL ops are idempotent: archiving an already-archived deployment is
  // a no-op; purging an already-purged one is too.

  /**
   * Make this deployment the live one, swapping away from whatever was
   * active before (`from`) in the same call so there's no "nothing
   * active" window.
   *
   * ONLY implemented by runtimes with the "unitRestore" capability —
   * those whose artifact is a durable per-deployment unit that can be
   * restarted in place (bare, cloud). Absent on Docker by design.
   *
   * NOT used by the initial deploy path — that's `deploy()`.
   *
   * Returns identifiers the orchestrator needs to persist on the
   * deployment row (new workspace ID for Cloud, etc.).
   */
  makeActive?(input: RollbackInput): Promise<MakeActiveResult>;

  /**
   * Preserve this deployment's artifact in non-active state so it can
   * be restored later. Idempotent.
   *   Docker — `docker stop`; the IMAGE is what's retained (by the
   *            rollback-window keep-set in modules/deployments/image-gc),
   *            and the container is usually already gone.
   *   Bare   — stop the supervisor unit; release dir stays on disk.
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
  /** The target's cpu/memory caps, so a runtime that has to re-create
   *  anything restores the limits it originally had instead of dropping
   *  them. Undefined/0 = no cap (self-hosted default). */
  resources?: ResourceConfig;
}

export interface MakeActiveResult {
  /** New container/unit ID if the runtime assigned one. Undefined when no
   *  ID change happened (existing unit restarted). */
  containerId?: string;
  /** New URL if the runtime assigned one (Cloud launches new
   *  workspace at fresh URL). Undefined when the URL is stable. */
  url?: string;
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
  /**
   * #332: structured argv for the container Cmd (docker-compose semantics —
   * overrides image CMD, NO implicit `sh -c`). When set, it wins over `command`.
   * `null`/absent → fall back to the legacy `["sh","-c",command]` wrap; `[]` →
   * clear the image CMD.
   */
  commandArgv?: string[] | null;
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
  /** Additional east-west DNS aliases resolving to this container ALONGSIDE the
   *  default `serviceName` — e.g. an operator-chosen `service.advanced.alias`.
   *  Every entry is a live name on the project network; loopback publish
   *  unchanged. Already normalized (DNS-safe) by the caller. */
  extraAliases?: string[];
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
  /** First network IP the list view reports — the internal address siblings
   *  reach this container on. Absent for a non-running container. */
  ip?: string;
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
  /** Live cpu/memory caps read off HostConfig, so adopting a container keeps the
   *  limits it was actually running with — including one set by hand with
   *  `docker update --memory`. Omitted fields mean the container had no cap. */
  resources?: { cpuCores?: number; memoryMb?: number };
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
