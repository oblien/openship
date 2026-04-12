/**
 * Platform — the single entry point that composes runtime + infra + system.
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
 *   │  System      │  —           │  docker, git │  git, nginx  │  —             │
 *   │  Toolchain   │  —           │  —           │  per-stack   │  —             │
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
import type { CommandExecutor, SshConfig } from "./types";
import type { SetupStateStore } from "./system/state";
import type { InstallerConfig } from "./system/types";
import type { SystemManager } from "./system/setup";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Deployment target — determines which providers are used.
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
   * This is the ONLY choice for self-hosted — everything else follows:
  *   - "docker" → Docker containers + Nginx + certbot (default)
  *   - "bare"   → Node.js processes + Nginx + certbot
   */
  runtime?: "docker" | "bare";
  /** Docker connection options (only for docker runtime) */
  docker?: import("./runtime/docker").DockerConnectionOptions;
  /** Bare runtime options (only for bare runtime) */
  bare?: import("./runtime/bare").BareRuntimeOptions;
  /** Nginx provider options for self-hosted routing + SSL */
  nginx?: Omit<import("./infra/nginx").NginxProviderOptions, "executor" | "paths">;
  /** Oblien client ID (cloud target — master creds) */
  cloudClientId?: string;
  /** Oblien client secret (cloud target — master creds) */
  cloudClientSecret?: string;
  /** Oblien namespace-scoped token (cloud target — local instances) */
  cloudToken?: string;
  /**
   * SSH config for remote server management (self-hosted only).
   *
  * When provided, all system checks, installations, and Nginx file
   * operations run on the remote server via SSH instead of locally.
   * When omitted, everything runs on the current machine.
   */
  ssh?: SshConfig;
  /**
   * Custom state store for caching setup results.
   * Defaults to FileStateStore. The API layer can provide a DB-backed store.
   */
  stateStore?: SetupStateStore;
  /** Pre-collected installer configuration (ACME email, domain, etc.) */
  installerConfig?: InstallerConfig;
}

/**
 * The resolved platform — everything service code needs.
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
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a platform instance.
 *
 * This is the MAIN factory. Call it once at server startup. The returned
 * Platform is then cached via `initPlatform()` / `getPlatform()`.
 *
 * Async — uses dynamic imports so each target only loads its own deps.
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

  // Single Oblien client — either from token or master creds
  const client = config.cloudToken
    ? new Oblien({ token: config.cloudToken })
    : new Oblien({
        clientId: config.cloudClientId ?? process.env.OBLIEN_CLIENT_ID ?? "",
        clientSecret: config.cloudClientSecret ?? process.env.OBLIEN_CLIENT_SECRET ?? "",
      });

  const infra = new CloudInfraProvider(client);

  return {
    target: "cloud",
    runtime: new CloudRuntime(client),
    routing: infra,
    ssl: infra,
    system: null,
    executor: null,
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
  };
}

/**
 * Create the routing + SSL provider for self-hosted deployments.
 *
 * Detects OpenResty paths from the target server, then creates
 * the provider with the actual paths — no hardcoded fallbacks.
 */
async function createInfraProvider(
  _mode: "docker" | "bare",
  config: PlatformConfig,
  executor: CommandExecutor,
): Promise<{ routing: RoutingProvider; ssl: SslProvider }> {
  const { detectOpenRestyPaths, ensureOpenRestyConfig } = await import("./infra/openresty-lua");
  const paths = await detectOpenRestyPaths(executor);

  // Idempotent — ensures sites-enabled dir + include directive exist
  await ensureOpenRestyConfig(executor, paths);

  const { NginxProvider } = await import("./infra/nginx");
  const nginx = new NginxProvider({ paths, ...config.nginx, executor });
  return { routing: nginx, ssl: nginx };
}

async function createSelfHostedPlatform(config: PlatformConfig): Promise<Platform> {
  const runtimeMode = config.runtime ?? "docker";

  // Executor — local or SSH based on config
  const { createExecutor } = await import("./system/executor");
  const executor = createExecutor(config.ssh);

  // System — runtime mode determines all required components
  const { SystemManager } = await import("./system/setup");
  const system = new SystemManager(runtimeMode, {
    executor,
    stateStore: config.stateStore,
    installerConfig: config.installerConfig,
  });

  // Runtime
  let runtime: RuntimeAdapter;
  if (runtimeMode === "bare") {
    const { BareRuntime } = await import("./runtime/bare");
    runtime = new BareRuntime({ ...config.bare, executor, systemManager: system });
  } else {
    const { DockerRuntime } = await import("./runtime/docker");
    runtime = new DockerRuntime(config.docker, system);
  }

  // Infrastructure — runtime implies the reverse proxy
  const { routing, ssl } = await createInfraProvider(runtimeMode, config, executor);

  return {
    target: "selfhosted",
    runtime,
    routing,
    ssl,
    system,
    executor,
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
 * Reset the platform singleton (for testing).
 */
export function resetPlatform(): void {
  _platform = null;
}
