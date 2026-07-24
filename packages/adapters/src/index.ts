/**
 * @repo/adapters - platform abstraction layer.
 *
 * Three layers, one entry point:
 *   1. Runtime  → build/deploy/stop/start lifecycle (Docker, Bare, Cloud)
 *   2. Infra    → routing (OpenResty) + SSL (certbot/ACME) - separate from runtime
 *   3. System   → prerequisite checks + setup validation (self-hosted only)
 *
 * The Platform ties them together:
 *   const { runtime, routing, ssl, system } = getPlatform();
 */

// ─── Shared types ────────────────────────────────────────────────────────────
export type {
  ResourceConfig,
  ContainerStatus,
  BuildStrategy,
  BuildConfig,
  DeployPublicEndpoint,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  BuildStep,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
  RouteConfig,
  RouteProxyLocation,
  RouteRedirect,
  RouteHeaderRule,
  SslResult,
  ManualCert,
  SshConfig,
  CommandExecutor,
  ShellOptions,
  ShellSession,
  ProvisionLock,
} from "./types";

export { BUILD_STEPS } from "./types";

export { DEFAULT_RESOURCE_CONFIG, DEFAULT_BUILD_RESOURCE_CONFIG } from "./types";

// ─── Runtime layer ───────────────────────────────────────────────────────────
export type {
  RuntimeAdapter,
  RuntimeCapability,
  MultiServiceRuntimeAdapter,
  MultiServiceGroupHandle,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  DeploymentRef,
  RollbackInput,
  MakeActiveResult,
  DockerMount,
  DockerPortBinding,
  DockerContainerSummary,
  DockerContainerDetail,
  DockerVolumeInfo,
  DockerNetworkInfo,
} from "./runtime/types";
export { assertCapability, isMultiServiceRuntime } from "./runtime/types";
export { DockerRuntime, type DockerConnectionOptions } from "./runtime/docker";
export { BareRuntime, type BareRuntimeOptions } from "./runtime/bare";
export {
  CloudRuntime,
  type CloudAdminProxy,
  PAGE_CONTAINER_PREFIX,
  provisionCloudWorkspace,
} from "./runtime/cloud";
export { BuildLogger } from "./runtime/build-pipeline";
export {
  type DeployEnvironment,
  type DeployRouting,
  type DeployPipelineInput,
  type DeployPipelineResult,
  type PromptPayload,
  type PromptUserFn,
  runDeployPipeline,
} from "./runtime/deploy-pipeline";
export {
  type RoutedDomainInput,
  type RouteRegistrationOptions,
  registerResolvedRoutes,
} from "./runtime/route-registration";
export {
  type PortOccupant,
  probeListeningPort,
  ensurePortAvailable,
} from "./runtime/port-conflict";
export {
  allocateHostPort,
  pickHostPort,
  type AllocateHostPortOptions,
} from "./runtime/host-port";
export { type RuntimeMode, type CreateRuntimeOptions, createRuntime } from "./runtime/index";
export { resolveDockerfileCandidates } from "./runtime/docker-paths";

// ─── Infrastructure layer ────────────────────────────────────────────────────
export type { RoutingProvider, SslProvider } from "./infra/types";
export { NginxProvider, type NginxProviderOptions, type RateLimitConfig } from "./infra/nginx";
export {
  compileVercelRouting,
  sourceToLocation,
  type CompiledRouting,
  type CompiledRedirect,
  type CompiledHeaderRule,
} from "./infra/vercel-routing";
export {
  compileRoutingToOblien,
  type OblienRoutingContext,
} from "./runtime/oblien-routing";
export { CloudInfraProvider } from "./infra/cloud";
export { NoopInfraProvider } from "./infra/noop";
export {
  OPENRESTY_MGMT_PORT,
  deployLuaScripts,
  detectOpenRestyPaths,
  type OpenRestyPaths,
} from "./infra/openresty-lua";

// ─── System layer ────────────────────────────────────────────────────────────
export type {
  ComponentStatus,
  EdgeClassification,
  EdgeOccupant,
  EdgePolicy,
  EdgeStatus,
  EdgeStopTarget,
  Feature,
  FeatureReadiness,
  InstallerConfig,
  InstallResult,
  PrerequisiteRule,
  ProxyKind,
  RuntimeMode as SystemRuntimeMode,
  SystemComponentDefinition,
  SetupResult,
  SystemCheckResult,
  SystemLog,
  SystemLogCallback,
} from "./system/types";
export type { EdgeConflictDetails, ImportedSite, ProxyScanResult } from "./system/types";
export {
  classifyProxy,
  EdgeConflictError,
  EdgeMigrateRequested,
  freeEdgeTargets,
  probeEdge,
  stopTargetsForStatus,
} from "./system/proxy/detect";
export { scanImportableSites, canImportProxy, scanOpenshipEdge } from "./system/proxy/import";
export {
  runEdgeTakeover,
  recoverInterruptedTakeover,
  type EdgeTakeoverOptions,
  type EdgeTakeoverResult,
} from "./system/proxy/takeover";
// The consolidated reverse-proxy / edge facade (single point for the chain).
export { detectEdge, importSites, takeoverOnMigrate, foreignProxyOnEdge, ensureEdge } from "./system/proxy";

export type { SetupState, SetupStateStore, ComponentState } from "./system/state";
export { FileStateStore } from "./system/state";

export type {
  EnvironmentProfile,
  LinuxDistro,
  SystemArch,
  SystemOs,
  SystemPackageManager,
  SystemServiceManager,
} from "./system/environment";
export { resolveEnvironment } from "./system/environment";
export { systemCatalog } from "./system/catalog";
// Native-module versioning + migration framework (verify → reconcile).
export {
  resolveVerifiedCatalog,
  loadEmbeddedCatalog,
  fetchRemoteCatalog,
  reconcileServerModule,
  readManifest,
  readManifestOrSeed,
  manifestPath,
  MODULES_STATE_DIR,
  type VerifiedCatalog,
  type ModuleCatalog,
  type ReconcileResult,
  type ReconcileOptions,
  type PendingConsent,
  type OnBoxManifest,
} from "./system/modules";
export { SYSTEM_COMPONENTS, getSystemComponentDefinition } from "./system/components";
export {
  isRemoteConnectionError,
  isRetryableRemoteConnectionError,
  isSshAuthError,
  isRuntimeNotFoundError,
  isSshDisconnectedError,
  SshDisconnectedError,
} from "./system/errors";
export { probeTcp, probeHttp, waitForReady } from "./system/reachability";
export {
  parseListeningPorts,
  probePortListeningOnce,
  waitForPortListening,
  type PortProbeExecutor,
  type PortProbeResult,
} from "./system/port-listen";
export {
  scanPorts,
  parseSsListeners,
  parseProcNetListeners,
  isLoopbackAddress,
  describeService,
  type PortScanExecutor,
  type PortScanResult,
  type HostListener,
  type PortProto,
  type PortFamily,
} from "./system/port-scan";
export { probeStaticOutput, type OutputProbeResult } from "./system/output-exists";

export { LocalExecutor, SshExecutor, SystemSshExecutor, createExecutor, createHostExecutor } from "./system/executor";
export { DockerEdgeExecutor } from "./system/docker-edge-executor";
export {
  ensureRemoteJournal,
  runJournaled,
  runReliable,
  execReliable,
  parseFrame,
  OpInterruptedError,
  OPSH_RUN_VERSION,
  REMOTE_ENV_PREFIX,
  type JournalRunResult,
  type RunJournaledOptions,
  type ReliableRunResult,
  type RunReliableOptions,
} from "./system/remote-journal";

export {
  checkAll as checkAllComponents,
  checkComponents,
  checkCertbot,
  checkDocker,
  checkGit,
  checkOpenResty,
  COMPONENT_CHECKS,
} from "./system/checks";
export {
  COMPONENT_INSTALLERS,
  COMPONENT_UNINSTALLERS,
  getRemovalSupport,
  installCertbot,
  installDocker,
  installGit,
  installOpenResty,
  installRsync,
  uninstallCertbot,
  uninstallOpenResty,
  uninstallRsync,
} from "./system/installer";
export { SystemManager, type SystemManagerOptions } from "./system/setup";

// ─── Toolchain layer ────────────────────────────────────────────────────────
export type {
  ToolchainStatus,
  ToolchainCheckResult,
  ToolchainCheckEntry,
  ToolchainInstallPlan,
  ToolchainInstallResult,
} from "./toolchain";

export { toolchainCatalog } from "./toolchain";
export { checkTool, checkTools, checkToolchain, checkToolchainForStack } from "./toolchain";
export { installTool, installTools } from "./toolchain";

// ─── Dockerfile planning ────────────────────────────────────────────────────
export type {
  CompileDockerfileOptions,
  DockerfileCommandForm,
  DockerfileInstruction,
  DockerfileInstructionKeyword,
  DockerfileParseResult,
  WorkspaceBuildPlan,
  WorkspaceBuildStagePlan,
  WorkspaceCommand,
  WorkspaceCopyStep,
  WorkspaceExposedPort,
  WorkspacePlanDiagnostic,
  WorkspacePlanSeverity,
  WorkspaceRuntimePlan,
  WorkspaceRunStep,
  WorkspaceStageStep,
} from "./dockerfile";
export {
  compileDockerfileParseResult,
  compileDockerfileToWorkspacePlan,
  parseDockerfile,
} from "./dockerfile";

// ─── Platform (top-level entry point) ────────────────────────────────────────
export type { PlatformTarget, PlatformConfig, Platform } from "./platform";
export { createPlatform, initPlatform, getPlatform, resetPlatform } from "./platform";

// ─── Oblien SDK (re-export for single source of truth) ───────────────────────
export { Oblien } from "oblien";
export type {
  NamespaceUsageUnits,
  NamespaceUsageUnitBucket,
  NamespaceUsageUnitsParams,
} from "oblien";

// ─── Backup adapters (importing the index seeds all three registries) ───────
export * from "./backup";
