/**
 * System layer barrel exports.
 */

export type {
  EnvironmentProfile,
  LinuxDistro,
  SystemArch,
  SystemOs,
  SystemPackageManager,
  SystemServiceManager,
} from "./environment";
export { resolveEnvironment } from "./environment";

// ─── Types ───────────────────────────────────────────────────────────────────
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
  RuntimeMode,
  SetupResult,
  SystemCheckResult,
  SystemLog,
  SystemLogCallback,
} from "./types";

// ─── Edge preflight + takeover ──────────────────────────────────────────────────
export {
  classifyProxy,
  EdgeConflictError,
  EdgeMigrateRequested,
  freeEdgeTargets,
  ourEdgeContainerRunning,
  probeEdge,
  stopTargetsForStatus,
} from "./proxy/detect";
export type { EdgeConflictDetails, ImportedSite, ProxyScanResult } from "./types";
export { scanImportableSites, canImportProxy } from "./proxy/import";
export {
  runEdgeTakeover,
  type EdgeTakeoverOptions,
  type EdgeTakeoverResult,
} from "./proxy/takeover";
export {
  recoverInterruptedTakeover,
  beginEdgeTakeover,
  rollbackEdgeTakeover,
  completeEdgeTakeover,
} from "./proxy/takeover-journal";
// The consolidated reverse-proxy / edge facade (single point for the chain).
export { detectEdge, importSites, takeoverOnMigrate, foreignProxyOnEdge, ensureEdge } from "./proxy";

// ─── State ───────────────────────────────────────────────────────────────────
export type { SetupState, SetupStateStore, ComponentState } from "./state";
export { FileStateStore } from "./state";

// ─── Executor ────────────────────────────────────────────────────────────────
export { LocalExecutor, SshExecutor, SystemSshExecutor, createExecutor } from "./executor";
// Privilege elevation for non-root SSH users (component installs use it; the
// broader remote-exec surface can adopt it as a follow-up — see #84).
export { elevatedExecutor, elevateCommand } from "./elevated-executor";

// ─── Checks ──────────────────────────────────────────────────────────────────
export {
  checkAll,
  checkComponents,
  checkDocker,
  checkGit,
  checkEdge,
  checkRsync,
  COMPONENT_CHECKS,
} from "./checks";

// ─── Installers ───────────────────────────────────────────────────────────────
export {
  COMPONENT_INSTALLERS,
  COMPONENT_UNINSTALLERS,
  getRemovalSupport,
  installDocker,
  installGit,
  installRsync,
  uninstallEdge,
  uninstallRsync,
} from "./installer";

// ─── Manager ─────────────────────────────────────────────────────────────────
export { SystemManager, type SystemManagerOptions } from "./setup";
