/**
 * Platform - the single entry point that composes runtime + infra + system.
 *
 * Same codebase, three deployment targets:
 *
 *   ┌──────────────┬──────────────┬─────────────────────────────┬────────────────┐
 *   │              │  cloud       │  selfhosted                 │  desktop       │
 *   ├──────────────┼──────────────┼──────────────┬──────────────┼────────────────┤
 *   │              │              │  docker      │  bare        │                │
 *   ├──────────────┼──────────────┼──────────────┼──────────────┼────────────────┤
 *   │  Runtime     │  CloudAPI    │  Docker      │  Bare        │  Bare          │
 *   │  Routing     │  CloudAPI    │  Nginx       │  Nginx       │  No-op         │
 *   │  SSL         │  CloudAPI    │  certbot     │  certbot     │  No-op         │
 *   │  System      │  -           │  docker, git │  git, nginx  │  -             │
 *   │  Toolchain   │  -           │  -           │  per-stack   │  -             │
 *   └──────────────┴──────────────┴──────────────┴──────────────┴────────────────┘
 *
 * Build-time separation:
 *   All code exists in the same codebase. The `createPlatform()` factory
 *   resolves the right combination based on config. Tree-shaking at build
 *   time can eliminate unused adapters from the final bundle.
 *
 * Usage:
 *   // At server startup (once):
 *   const platform = createPlatform({ target: "selfhosted", runtime: "docker" });
 *
 *   // In service code (always):
 *   const { runtime, routing, ssl, system } = getPlatform();
 *   await runtime.build(config, onLog);
 *   await routing.registerRoute({ domain, targetUrl, tls: true });
 *   await ssl.provisionCert(domain);
 *   if (system) await system.requireFeature("deploy");
 */

import type { RuntimeAdapter } from "./runtime/types";
import type { RoutingProvider, SslProvider } from "./infra/types";
import type { CommandExecutor, SshConfig, ProvisionLock } from "./types";
import type { SetupStateStore } from "./system/state";
import type { InstallerConfig } from "./system/types";
import type { SystemManager } from "./system/setup";
import type { DockerConnectionOptions } from "./runtime/docker";
import type { BareRuntimeOptions } from "./runtime/bare";
import type { NginxProviderOptions } from "./infra/nginx";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Deployment target - determines which providers are used.
 *
 *   "cloud"      → Everything managed by Oblien API. No local setup.
 *   "selfhosted" → Docker or Bare runtime + Nginx routing/SSL. System checks.
 *   "desktop"    → Bare runtime, no routing/SSL, no system setup.
 */
export type PlatformTarget = "cloud" | "selfhosted" | "desktop";

export interface PlatformConfig {
  /** Deployment target */
  target: PlatformTarget;
  /**
   * Runtime mode for self-hosted (ignored for cloud/desktop).
   *
   * This is the ONLY choice for self-hosted - everything else follows:
  *   - "docker" → Docker containers + Nginx + certbot (default)
  *   - "bare"   → Node.js processes + Nginx + certbot
   */
  runtime?: "docker" | "bare";
  /** Docker connection options (only for docker runtime) */
  docker?: DockerConnectionOptions;
  /** Bare runtime options (only for bare runtime) */
  bare?: BareRuntimeOptions;
  /** Nginx provider options for self-hosted routing + SSL */
  nginx?: Omit<NginxProviderOptions, "executor" | "paths">;
  /** Oblien client ID (cloud target - master creds) */
  cloudClientId?: string;
  /** Oblien client secret (cloud target - master creds) */
  cloudClientSecret?: string;
  /** Oblien namespace-scoped token (cloud target - local instances) */
  cloudToken?: string;
  /**
   * Admin-scoped Oblien operations that namespace tokens can't perform.
   * Local/desktop instances inject these so CloudRuntime can hand them
   * off to the SaaS (which runs them with the master client). SaaS
   * instances leave this unset — the direct client already has admin
   * scope.
   *
   * Currently scoped to static-page creation on shared zones like
   * `opsh.io`; same shape as analytics/edge-proxy proxy pattern.
   */
  cloudAdminProxy?: import("./runtime/cloud").CloudAdminProxy;
  /**
   * Allow a CLOUD-target runtime to do work on the machine this API process runs on
   * (the "build locally, upload the output" strategy, and the local-source Dockerfile
   * path). Cloud target only — the selfhosted and desktop runtimes ARE the host.
   *
   * Omitted → DENY. That is the opposite of every other optional field here, and
   * deliberately so: this one is a boundary, and a permissive default is exactly how
   * a tenant's build commands came to be runnable on the multi-tenant control plane.
   * A self-hosted box orchestrating a cloud deploy must opt in explicitly.
   */
  allowHostBuild?: boolean;
  /**
   * SSH config for remote server management (self-hosted only).
   *
  * When provided, all system checks, installations, and Nginx file
   * operations run on the remote server via SSH instead of locally.
   * When omitted, everything runs on the current machine.
   */
  ssh?: SshConfig;
  /**
   * Pre-built command executor (self-hosted only).
   *
   * When provided, this executor is used instead of creating a new one
   * from `ssh`. Use this to inject a managed/pooled executor (e.g. from
   * SshConnectionManager) so all server operations share a single
   * connection per server.
   */
  executor?: CommandExecutor;
  /**
   * The target IS the machine this API process runs on (self-hosted only).
   *
   * `!executor && !ssh` used to stand in for this, and the proxy broke for the
   * auto-registered "This Server" row: it deploys to the local box but injects the
   * pooled HOST executor, so the local-edge fast path was skipped and routing took an
   * SSH excursion to `host.docker.internal` — the same machine, the long way round,
   * and one more thing that can fail. On a compose install with a default-deny
   * firewall that excursion is exactly what killed every deploy (#490), while the
   * Docker socket that does the real work was fine the whole time.
   *
   * Unset → inferred from the absence of an injected executor, as before.
   */
  localHost?: boolean;
  /**
   * Custom state store for caching setup results.
   * Defaults to FileStateStore. The API layer can provide a DB-backed store.
   */
  stateStore?: SetupStateStore;
  /** Pre-collected installer configuration (ACME email, domain, etc.) */
  installerConfig?: InstallerConfig;
  /**
   * Serializes server-scoped provisioning across concurrent deploys (self-hosted
   * only). The API injects an in-process mutex + Postgres advisory lock keyed by
   * the target server, so two deploys never race apt/dpkg, the openresty unit +
   * config, docker networks, or the setup-state file. Omitted → no serialization.
   */
  provisionLock?: ProvisionLock;
}

/**
 * The resolved platform - everything service code needs.
 *
 * This is what you get back from `createPlatform()` or `getPlatform()`.
 * Each layer has a single responsibility:
 *   - runtime: build/deploy/stop/start/restart/destroy + observability
 *   - routing: register/remove reverse-proxy routes
 *   - ssl: provision/renew TLS certificates
 *   - system: prerequisite validation (self-hosted only, null otherwise)
 */
export interface Platform {
  /** Which target this platform was created for */
  readonly target: PlatformTarget;
  /** Build/deploy/stop/start lifecycle */
  readonly runtime: RuntimeAdapter;
  /** Reverse-proxy route management */
  readonly routing: RoutingProvider;
  /** TLS certificate management */
  readonly ssl: SslProvider;
  /** System setup & prerequisites (only for self-hosted) */
  readonly system: SystemManager | null;
  /**
   * The command executor powering this platform.
   * Local for same-machine, SSH for remote.
   * Null for cloud/desktop (no system management needed).
   */
  readonly executor: CommandExecutor | null;
  /**
   * The deploy target IS the machine this API process runs on.
   *
   * The RESOLVED answer, not the config hint — `createSelfHostedPlatform` already
   * derives it (an `ssh` config always wins over the flag), and consumers that
   * re-derived it from "is `executor` injected" got the auto-registered "This
   * Server" row wrong. Exposed because it decides which executor reaches a path the
   * api container SHARES with its host (see EDGE_CONTAINER_MOUNTS): on the local box
   * those paths are the same files, so they need no host channel at all.
   */
  readonly localHost: boolean;
}

/**
 * The executor that reaches a path the api container shares 1:1 with its host.
 *
 * `EDGE_SAME_PATH_MOUNTS` is the set that qualifies — today the static release tree
 * (`STATIC_RELEASE_BASE`) and certbot's store (`/etc/letsencrypt`) —
 * so on the local box they are the same files, a local executor reaches them, and no
 * host channel is involved. Routing them over the host SSH channel instead is what
 * made static deploys, static rollback and cert adoption the things a blocked or
 * disabled channel broke for no reason (#490); the edge that serves those files is on
 * this box too, reading the same mount.
 *
 * ONLY for a same-path mount. `sites-enabled` is bind-mounted from
 * `EDGE_HOST_STATE_DIR` to a DIFFERENT path inside the container
 * (`OPENRESTY_DEFAULT_PATHS.sitesDir`), so a local read there looks somewhere else
 * entirely — vhost reads must stay on the host executor.
 *
 * A remote target shares no mount at all, so there its own executor is the only thing
 * that can see the path. Takes the two fields it decides on rather than a whole
 * `Platform`, so a caller holding a resolved `{ isLocal, executor }` can use it too.
 */
export async function sharedMountExecutor(target: {
  localHost: boolean;
  executor: CommandExecutor | null;
}): Promise<CommandExecutor | null> {
  if (!target.localHost) return target.executor;
  const { createExecutor } = await import("./system/executor");
  return createExecutor();
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a platform instance.
 *
 * This is the MAIN factory. Call it once at server startup. The returned
 * Platform is then cached via `initPlatform()` / `getPlatform()`.
 *
 * Async - uses dynamic imports so each target only loads its own deps.
 * This runs once at startup. After init, `getPlatform()` is synchronous.
 */
export async function createPlatform(config: PlatformConfig): Promise<Platform> {
  switch (config.target) {
    case "cloud":
      return createCloudPlatform(config);
    case "desktop":
      return createDesktopPlatform(config);
    case "selfhosted":
    default:
      return createSelfHostedPlatform(config);
  }
}

async function createCloudPlatform(config: PlatformConfig): Promise<Platform> {
  const { Oblien } = await import("oblien");
  const { CloudRuntime } = await import("./runtime/cloud");
  const { CloudInfraProvider } = await import("./infra/cloud");

  // Single Oblien client - either from token or master creds
  const client = config.cloudToken
    ? new Oblien({ token: config.cloudToken })
    : new Oblien({
        clientId: config.cloudClientId ?? process.env.OBLIEN_CLIENT_ID ?? "",
        clientSecret: config.cloudClientSecret ?? process.env.OBLIEN_CLIENT_SECRET ?? "",
      });

  const infra = new CloudInfraProvider(client);

  return {
    target: "cloud",
    runtime: new CloudRuntime(client, {
      adminProxy: config.cloudAdminProxy,
      allowHostBuild: config.allowHostBuild,
    }),
    routing: infra,
    ssl: infra,
    system: null,
    executor: null,
    // The workload runs in Oblien's infrastructure, never on this box.
    localHost: false,
  };
}

async function createDesktopPlatform(config: PlatformConfig): Promise<Platform> {
  const { BareRuntime } = await import("./runtime/bare");
  const { NoopInfraProvider } = await import("./infra/noop");

  const noop = new NoopInfraProvider();
  return {
    target: "desktop",
    runtime: new BareRuntime(config.bare),
    routing: noop,
    ssl: noop,
    system: null,
    executor: null,
    // "This Machine" — the desktop app deploys to the box it runs on.
    localHost: true,
  };
}

/**
 * Create the routing + SSL provider for self-hosted deployments.
 *
 * Detects OpenResty paths from the target server, then creates
 * the provider with the actual paths - no hardcoded fallbacks.
 */
async function createInfraProvider(
  _mode: "docker" | "bare",
  config: PlatformConfig,
  executor: CommandExecutor,
  edgeContainer?: string,
): Promise<{ routing: RoutingProvider; ssl: SslProvider }> {
  // Both container-edge branches delegate to ensure-container-edge, which owns the
  // paths/pin decision for the edge image. Constructing the provider here too is
  // what let the two drift — and pointing `sitesDir` at a directory the edge never
  // reads fails silently, with the box dark.
  const { containerEdgeProvider, localContainerEdgeProvider } = await import(
    "./system/proxy/ensure-container-edge"
  );

  // LOCAL containerized edge (compose): the api shares the routing mounts with the
  // `openship-edge` container and reaches it over the mounted Docker socket.
  if (edgeContainer) {
    const nginx = await localContainerEdgeProvider(edgeContainer, config.nginx);
    return { routing: nginx, ssl: nginx };
  }

  // REMOTE box already running our edge container — same edge, reached over the
  // pooled SSH executor rather than a socket.
  const { resolveOurEdgeContainer } = await import("./system/proxy/detect");
  const remoteEdge = await resolveOurEdgeContainer(executor).catch(() => null);
  if (remoteEdge) {
    const nginx = await containerEdgeProvider(executor, remoteEdge, config.nginx);
    return { routing: nginx, ssl: nginx };
  }

  // No bare edge on a non-Linux host. The paths below are Linux FHS (`/var/www/acme`,
  // `/usr/local/openresty/...`) and provisioning them needs root, so on macOS this
  // failed the deploy outright with `EACCES: mkdir '/var/www'` — before the workload
  // was even built. Nor is there anything to install: the edge is a Linux container
  // image, and the host-package path it used to fall back to is gone.
  //
  // Gated on the executor being LOCAL, because `process.platform` describes THIS
  // process, not the target: a Mac driving a remote Linux box must still get the real
  // provider. Both container-edge branches above are checked first, so a Mac running
  // the compose stack keeps its edge — this only replaces the bare path, where the
  // alternative is a hard failure.
  const { LocalExecutor } = await import("./system/local-executor");
  if (executor instanceof LocalExecutor && process.platform !== "linux") {
    const { NoopInfraProvider } = await import("./infra/noop");
    const noop = new NoopInfraProvider();
    return { routing: noop, ssl: noop };
  }

  // Bare host OpenResty: legacy boxes not yet converted, and Docker-less servers.
  // No longer something we install — see `installContainerEdge`.
  const { detectOpenRestyPaths, ensureOpenRestyConfig, ensureLuaScripts } = await import(
    "./infra/openresty-lua"
  );

  // Guarded for the same reason as `ensureOpenRestyConfig` below, one step earlier:
  // this is the first thing here that touches the target box, so an executor that
  // cannot reach it AT ALL threw straight out of platform construction — upstream of
  // every best-effort routing step — and failed the deploy before the build even
  // started. That is exactly what a firewalled container→host bridge produced (#490):
  // a compose install where every deploy died on an SSH handshake timeout while the
  // Docker socket that does the actual work was fine.
  //
  // No reachable edge is a routing gap, and routing gaps never fail a deploy.
  let paths: Awaited<ReturnType<typeof detectOpenRestyPaths>>;
  try {
    paths = await detectOpenRestyPaths(executor);
  } catch (err) {
    console.error(
      `[openresty] cannot reach the edge host (deploy continues without routing): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    const { NoopInfraProvider } = await import("./infra/noop");
    const noop = new NoopInfraProvider();
    return { routing: noop, ssl: noop };
  }

  // Everything from here on WRITES to root-owned paths — nginx.conf, the Lua dir, the
  // vhost dir, /etc/letsencrypt — so a non-root login needs sudo for all of it. Detection
  // above is a read and deliberately stays unelevated; this is the boundary.
  //
  // Refusal is not fatal for the same reason the two `catch`es around this one aren't: an
  // unwritable edge is a routing gap, and routing gaps never fail a deploy. It is logged
  // so the operator has the cause, because the alternative — what shipped — was an EACCES
  // attributed to whichever vhost write happened to surface it.
  // A separate binding rather than reassigning the parameter: the writes below need the
  // gate's answer specifically, and shadowing `executor` with a widened type is how the
  // unelevated one reached them in the first place.
  const { rootOrDegrade } = await import("./system/privilege");
  const edgeExecutor = await rootOrDegrade(executor, {
    purpose: "Configuring routing and TLS",
    consequence: "Routing may be incomplete (deploy continues; the app still runs on its port).",
    report: (message) => console.error(`[openresty] ${message}`),
  });

  // Idempotent, but writes the SHARED nginx.conf (grep||sed). Concurrent deploys
  // would race the non-atomic edit and lose/duplicate the include — serialize it.
  const ensureConfig = async () => {
    // Best-effort HERE, not in `ensureOpenRestyConfig` itself: the INSTALL path
    // (deployLuaScripts) must still fail loudly when it can't write nginx.conf.
    // On the DEPLOY path an unwritable edge is a routing gap, and routing gaps
    // never fail a deploy — the app still builds and runs. Left unguarded, this
    // threw during platform CONSTRUCTION, upstream of every best-effort routing
    // step, so the invariant never got a chance to apply (that's what turned a
    // macOS `mkdir /var/www` EACCES into "Deployment Failed").
    await ensureOpenRestyConfig(edgeExecutor, paths).catch((err: unknown) => {
      console.error(
        `[openresty] ensureOpenRestyConfig failed (deploy continues, routing may be ` +
          `incomplete): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // Self-heal the edge Lua on EVERY deploy — a box that lost rules_guard.lua
    // (reinstall, manual rm, a pre-embed release) would otherwise 500 every
    // request. Cheap: one listing, writes only what's missing, reloads only if
    // it repaired something. deployLuaScripts (with geo deps) stays install-only.
    await ensureLuaScripts(edgeExecutor, paths);
  };
  await (config.provisionLock ? config.provisionLock.run(ensureConfig) : ensureConfig());

  const { NginxProvider } = await import("./infra/nginx");
  const nginx = new NginxProvider({ paths, ...config.nginx, executor: edgeExecutor });
  return { routing: nginx, ssl: nginx };
}

async function createSelfHostedPlatform(config: PlatformConfig): Promise<Platform> {
  const runtimeMode = config.runtime ?? "docker";

  // The LOCAL edge-in-compose case only: here the api process shares the routing
  // mounts with the edge container and talks to the daemon over its own socket, so
  // it needs the dockerode executor. A REMOTE box's container edge is resolved by
  // probing that box (createInfraProvider) — not from this env, which describes
  // the control plane and says nothing about the target.
  //
  // An `ssh` config is unambiguously remote and always wins; otherwise trust the
  // explicit flag, falling back to the old inference. See PlatformConfig.localHost.
  const targetIsThisMachine = !config.ssh && (config.localHost ?? !config.executor);
  const useDockerEdge = targetIsThisMachine && process.env.OPENSHIP_EDGE_MODE === "docker";
  const edgeContainer = process.env.OPENSHIP_EDGE_CONTAINER?.trim() || "openship-edge";

  // Executor - use injected (managed/pooled) executor, or create a fresh one
  let executor: CommandExecutor;
  if (config.executor) {
    executor = config.executor;
  } else {
    const { createExecutor } = await import("./system/executor");
    executor = createExecutor(config.ssh);
  }

  // System - runtime mode determines all required components. In docker-edge
  // mode the stack provides docker (socket) + OpenResty/certbot (edge image), so
  // the api installs nothing on its container/host.
  const { SystemManager } = await import("./system/setup");
  const system = new SystemManager(runtimeMode, {
    executor,
    stateStore: config.stateStore,
    installerConfig: config.installerConfig,
    provisionLock: config.provisionLock,
    assumeInstalled: useDockerEdge,
  });

  // Runtime
  let runtime: RuntimeAdapter;
  if (runtimeMode === "bare") {
    const { BareRuntime } = await import("./runtime/bare");
    runtime = new BareRuntime({ ...config.bare, executor, systemManager: system });
  } else {
    const { DockerRuntime } = await import("./runtime/docker");
    runtime = await DockerRuntime.create(config.docker, system, config.provisionLock);
  }

  // Infrastructure - runtime implies the reverse proxy
  const { routing, ssl } = await createInfraProvider(
    runtimeMode,
    config,
    executor,
    useDockerEdge ? edgeContainer : undefined,
  );

  return {
    target: "selfhosted",
    runtime,
    routing,
    ssl,
    system,
    executor,
    localHost: targetIsThisMachine,
  };
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _platform: Platform | null = null;

/**
 * Initialize the global platform singleton.
 *
 * Call this ONCE at server startup. After this, `getPlatform()` returns
 * the cached instance synchronously.
 */
export async function initPlatform(config: PlatformConfig): Promise<Platform> {
  _platform = await createPlatform(config);
  return _platform;
}

/**
 * Get the initialized platform.
 *
 * Returns the cached Platform instance. Throws if `initPlatform()` hasn't
 * been called yet.
 *
 * This is the function all service code uses:
 *   const { runtime, routing, ssl } = getPlatform();
 */
export function getPlatform(): Platform {
  if (!_platform) {
    throw new Error(
      "Platform not initialized. Call initPlatform() at server startup.",
    );
  }
  return _platform;
}

/**
 * The singleton if there is one, without demanding that there be one.
 *
 * `getPlatform()` throws by design — service code that reads the platform has a bug if
 * startup never ran. This is for the one question with the opposite shape: "is this object
 * the process-wide platform?", asked by disposal code that must not tear down a layer it
 * does not own. That question is meaningful before init and inside unit tests, where the
 * answer is simply "no", and a throw there would turn an ownership check into an outage.
 */
export function peekPlatform(): Platform | null {
  return _platform;
}

/**
 * Reset the platform singleton (for testing).
 */
export function resetPlatform(): void {
  _platform = null;
}
