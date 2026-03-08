/**
 * Platform — the single entry point that composes runtime + infra + system.
 *
 * Same codebase, three deployment targets:
 *
 *   ┌──────────────┬──────────────┬──────────────┬────────────────┐
 *   │              │  cloud       │  selfhosted  │  desktop       │
 *   ├──────────────┼──────────────┼──────────────┼────────────────┤
 *   │  Runtime     │  CloudAPI    │  Docker/Bare │  Bare          │
 *   │  Routing     │  CloudAPI    │  Traefik     │  No-op         │
 *   │  SSL         │  CloudAPI    │  Traefik LE  │  No-op         │
 *   │  System      │  —           │  ✓ (checks)  │  —             │
 *   └──────────────┴──────────────┴──────────────┴────────────────┘
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
 *   "selfhosted" → Docker or Bare runtime + Traefik routing/SSL. System checks.
 *   "desktop"    → Bare runtime, no routing/SSL, no system setup.
 */
export type PlatformTarget = "cloud" | "selfhosted" | "desktop";

export interface PlatformConfig {
  /** Deployment target */
  target: PlatformTarget;
  /**
   * Runtime mode for self-hosted (ignored for cloud/desktop).
   * - "docker" → Docker Engine (default for selfhosted)
   * - "bare"   → Direct process management
   */
  runtime?: "docker" | "bare";
  /** Docker connection options (only for docker runtime) */
  docker?: import("./runtime/docker").DockerConnectionOptions;
  /** Bare runtime options (only for bare runtime) */
  bare?: import("./runtime/bare").BareRuntimeOptions;
  /** Traefik provider options (only for selfhosted target) */
  traefik?: Omit<import("./infra/traefik").TraefikProviderOptions, "executor">;
  /** Oblien API URL (only for cloud target) */
  cloudApiUrl?: string;
  /** Oblien API key (only for cloud target) */
  cloudApiKey?: string;
  /**
   * SSH config for remote server management (self-hosted only).
   *
   * When provided, all system checks, installations, and Traefik file
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
  const { CloudRuntime } = await import("./runtime/cloud");
  const { CloudInfraProvider } = await import("./infra/cloud");

  const apiUrl = config.cloudApiUrl ?? process.env.OBLIEN_API_URL ?? "https://api.oblien.com";
  const apiKey = config.cloudApiKey ?? process.env.OBLIEN_API_KEY ?? "";

  return {
    target: "cloud",
    runtime: new CloudRuntime(apiUrl, apiKey),
    routing: new CloudInfraProvider(apiUrl, apiKey),
    ssl: new CloudInfraProvider(apiUrl, apiKey),
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

async function createSelfHostedPlatform(config: PlatformConfig): Promise<Platform> {
  const runtimeMode = config.runtime ?? "docker";

  // Executor — local or SSH based on config
  const { createExecutor } = await import("./system/executor");
  const executor = createExecutor(config.ssh);

  // Runtime
  let runtime: RuntimeAdapter;
  if (runtimeMode === "bare") {
    const { BareRuntime } = await import("./runtime/bare");
    runtime = new BareRuntime({ ...config.bare, executor });
  } else {
    const { DockerRuntime } = await import("./runtime/docker");
    runtime = new DockerRuntime(config.docker);
  }

  // Infrastructure — pass executor for dual-path file operations
  const { TraefikProvider } = await import("./infra/traefik");
  const traefik = new TraefikProvider({ ...config.traefik, executor });

  // System — pass executor and state store
  const { SystemManager } = await import("./system/setup");
  const system = new SystemManager(runtimeMode, {
    executor,
    stateStore: config.stateStore,
    installerConfig: config.installerConfig,
  });

  return {
    target: "selfhosted",
    runtime,
    routing: traefik,
    ssl: traefik,
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
