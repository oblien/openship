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
  RouteHostRedirect,
  SslResult,
  ManualCert,
  SshConfig,
  CommandExecutor,
  ShellOptions,
  ShellSession,
  ProvisionLock,
  AmbientGitVia,
} from "./types";

// The one clone-command assembler (token / relay / ssh / ambient) + its shell
// quoting, shared with the API so a probe and the clone it predicts can't drift.
export {
  sq,
  assembleGitClone,
  injectGitToken,
  toGitHubSshUrl,
  type GitCloneAuth,
  type GitCloneInvocation,
} from "./runtime/git-clone";

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
  ContainerLifecycleEvent,
} from "./runtime/types";
export { assertCapability, isMultiServiceRuntime } from "./runtime/types";
export { DockerRuntime, type DockerConnectionOptions } from "./runtime/docker";
export {
  resolveLocalDockerSocketPath,
  DEFAULT_DOCKER_SOCKET_PATH,
} from "./runtime/docker-transport";
export {
  transferImage,
  type ImageTransferOptions,
  type ImageTransferResult,
} from "./runtime/image-transfer";
export { BareRuntime, STATIC_RELEASE_BASE, type BareRuntimeOptions } from "./runtime/bare";
// The doc-root resolver, exported so the output-check path derives the served
// location with the SAME confinement rules the deploy used (no reimplementation:
// this function is what rejects absolute paths and `../` traversal out of the root).
export { resolveServedStaticPath, resolveStaticOutputPath } from "./runtime/stack-output";
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
// Post-deploy stabilization watch — "the container was created" is not "the
// container stayed up", and every point-in-time status read says it did.
export {
  type ContainerStabilitySample,
  type StabilityOptions,
  type StabilityStatus,
  type StabilityVerdict,
  classifyStability,
  watchContainerStability,
  restartsAfter,
} from "./runtime/stability";
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
export { scopedVolumeName, scopeVolumeBinds, isHostPathSource } from "./runtime/volume-namespace";

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
  ACME_HTTP01_PORT,
  OPENRESTY_MGMT_PORT,
  EDGE_CONTAINER_MOUNTS,
  EDGE_HOST_PATHS,
  EDGE_HOST_STATE_DIR,
  EDGE_CHALLENGE_DIR,
  EDGE_CHALLENGE_HOST_DIR,
  EDGE_CHALLENGE_ROOT,
  EDGE_CHALLENGE_URL_PREFIX,
  EDGE_SHARED_DICTS,
  OPENRESTY_DEFAULT_PATHS,
  deployLuaScripts,
  detectOpenRestyPaths,
  edgeChallengeVhostConf,
  edgeDefaultCatchAllConf,
  edgeDefaultCertPaths,
  type OpenRestyPaths,
} from "./infra/openresty-lua";
export { bakedEdgeNginxConf } from "./infra/edge-baked-conf";
export {
  MAIL_CONTAINER,
  MAIL_DB_CONTAINER,
  MAIL_HOST_STATE_DIR,
  MAIL_CONTAINER_MOUNTS,
  MAIL_HOST_PATHS,
  MAIL_PORTS,
  MAIL_DB_NAME,
  MAIL_DB_USER,
  MAIL_DB_HOST_BIND,
  MAIL_DB_PORT,
  type MailMount,
} from "./infra/mail-container";

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
  detectEdgeContainer,
  EDGE_CONTAINER_NAME,
  EdgeConflictError,
  EdgeMigrateRequested,
  edgeCrashReason,
  edgeIsBroken,
  freeEdgeTargets,
  invalidateEdgeContainer,
  ourEdgeContainerRunning,
  probeEdge,
  resolveOurEdgeContainer,
  stopTargetsForStatus,
  type EdgeFreeResult,
} from "./system/proxy/detect";
export {
  buildImage,
  containerImageRef,
  containerState,
  dockerAvailable,
  imageExistsLocally,
  managedImagesAreFromSource,
  setManagedImagesFromSource,
  type ManagedImageKind,
} from "./system/managed-image";
export {
  containerEdgeProvider,
  ensureContainerEdge,
  resolveEdgeImage,
  setDefaultEdgeImage,
  buildEdgeRunCommand,
  verifyEdgeServing,
  type ContainerEdgeOptions,
  type ContainerEdgeResult,
  type EdgeServingVerdict,
} from "./system/proxy/ensure-container-edge";
export {
  ensureContainerMail,
  startContainerMail,
  resolveMailImage,
  setDefaultMailImage,
  detectMailContainer,
  verifyMailEngine,
  buildMailRunCommand,
  MAIL_DB_IMAGE,
  type ContainerMailOptions,
  type ContainerMailResult,
} from "./system/mail/ensure-container-mail";
export {
  detectMailEngine,
  startHostMail,
  HOST_MAIL_UNITS,
  type MailEngineFlavor,
  type MailEngineProbe,
} from "./system/mail/detect-engine";
export { scanImportableSites, canImportProxy, scanOpenshipEdge } from "./system/proxy/import";
export {
  runEdgeTakeover,
  registerImportedSites,
  type EdgeTakeoverOptions,
  type EdgeTakeoverResult,
  type RegisterImportedSitesOptions,
} from "./system/proxy/takeover";
export {
  recoverInterruptedTakeover,
  beginEdgeTakeover,
  rollbackEdgeTakeover,
  completeEdgeTakeover,
} from "./system/proxy/takeover-journal";
// The consolidated reverse-proxy / edge facade (single point for the chain).
export { detectEdge, importSites, takeoverOnMigrate, foreignProxyOnEdge, ensureEdge } from "./system/proxy";
export { unreachableStaticRoots } from "./system/proxy/import";
export type { UnreachableStaticRoot } from "./system/proxy/import";
// The reverse-proxy READ api: sites, by-port index, per-host vhost + cert.
export { edgeProxy, edgeProxyFor, buildProxyRouteIndex, collectProxyCerts } from "./system/proxy/api";
export type {
  EdgeProxyApi,
  ProxySiteRoute,
  ProxySiteRouteSsl,
  AdoptedCert,
  CertCandidate,
} from "./system/proxy/api";
export { validateCertFor, readDeclaredPair, isSafeCertPath } from "./system/proxy/cert-material";

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
export { elevatedExecutor, elevateCommand } from "./system/elevated-executor";
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

export { LocalExecutor, SshExecutor, SystemSshExecutor, createExecutor, createHostExecutor, hostControlDisabled } from "./system/executor";
export { DockerEdgeExecutor } from "./system/docker-edge-executor";
export {
  edgeContainerExecutor,
  containerCommand,
  readEdgeFile,
  writeEdgeFile,
  type EdgeFilesAt,
} from "./system/edge-container-executor";
export {
  EDGE_DOWN_MARKER,
  edgeDownExplanation,
  explainEdgeDown,
  isEdgeDownFailure,
  isEdgeDownMessage,
} from "./system/edge-exec-error";
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
  checkDocker,
  checkGit,
  checkEdge,
  COMPONENT_CHECKS,
} from "./system/checks";
export {
  COMPONENT_INSTALLERS,
  COMPONENT_UNINSTALLERS,
  getRemovalSupport,
  installContainerEdge,
  installDocker,
  installGit,
  installRsync,
  uninstallEdge,
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
