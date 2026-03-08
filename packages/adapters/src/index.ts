/**
 * @repo/adapters — platform abstraction layer.
 *
 * Three layers, one entry point:
 *   1. Runtime  → build/deploy/stop/start lifecycle (Docker, Bare, Cloud)
 *   2. Infra    → routing (Traefik) + SSL (ACME) — separate from runtime
 *   3. System   → prerequisite checks + setup validation (self-hosted only)
 *
 * The Platform ties them together:
 *   const { runtime, routing, ssl, system } = getPlatform();
 */

// ─── Shared types ────────────────────────────────────────────────────────────
export type {
  CpuConfig,
  ResourceConfig,
  ResourceTier,
  ContainerStatus,
  BuildConfig,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
  RouteConfig,
  SslResult,
  SshConfig,
  CommandExecutor,
} from "./types";

export {
  RESOURCE_TIERS,
  DEFAULT_RESOURCE_CONFIG,
  DEFAULT_BUILD_RESOURCE_CONFIG,
} from "./types";

// ─── Runtime layer ───────────────────────────────────────────────────────────
export type { RuntimeAdapter, RuntimeCapability } from "./runtime/types";
export { assertCapability } from "./runtime/types";
export { DockerRuntime, type DockerConnectionOptions } from "./runtime/docker";
export { BareRuntime, type BareRuntimeOptions } from "./runtime/bare";
export { CloudRuntime } from "./runtime/cloud";
export {
  type RuntimeMode,
  type CreateRuntimeOptions,
  createRuntime,
} from "./runtime/index";

// ─── Infrastructure layer ────────────────────────────────────────────────────
export type { RoutingProvider, SslProvider } from "./infra/types";
export { TraefikProvider, type TraefikProviderOptions } from "./infra/traefik";
export { CloudInfraProvider } from "./infra/cloud";
export { NoopInfraProvider } from "./infra/noop";

// ─── System layer ────────────────────────────────────────────────────────────
export type {
  ComponentStatus,
  Feature,
  FeatureReadiness,
  InstallerConfig,
  InstallResult,
  PrerequisiteRule,
  RuntimeMode as SystemRuntimeMode,
  SetupResult,
  SystemCheckResult,
  SystemLog,
  SystemLogCallback,
} from "./system/types";

export type { SetupState, SetupStateStore, ComponentState } from "./system/state";
export { FileStateStore } from "./system/state";

export { LocalExecutor, SshExecutor, createExecutor } from "./system/executor";

export {
  checkAll as checkAllComponents,
  checkBun,
  checkComponents,
  checkDocker,
  checkGit,
  checkNode,
  checkTraefik,
  COMPONENT_CHECKS,
} from "./system/checks";
export {
  COMPONENT_INSTALLERS,
  installBun,
  installDocker,
  installGit,
  installNode,
  installTraefik,
} from "./system/installer";
export { SystemManager, type SystemManagerOptions } from "./system/setup";

// ─── Platform (top-level entry point) ────────────────────────────────────────
export type { PlatformTarget, PlatformConfig, Platform } from "./platform";
export { createPlatform, initPlatform, getPlatform, resetPlatform } from "./platform";
