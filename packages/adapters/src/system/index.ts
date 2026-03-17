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
  Feature,
  FeatureReadiness,
  InstallerConfig,
  InstallResult,
  PrerequisiteRule,
  RuntimeMode,
  SetupResult,
  SystemCheckResult,
  SystemLog,
  SystemLogCallback,
} from "./types";

// ─── State ───────────────────────────────────────────────────────────────────
export type { SetupState, SetupStateStore, ComponentState } from "./state";
export { FileStateStore } from "./state";

// ─── Executor ────────────────────────────────────────────────────────────────
export { LocalExecutor, SshExecutor, createExecutor } from "./executor";

// ─── Checks ──────────────────────────────────────────────────────────────────
export {
  checkAll,
  checkComponents,
  checkDocker,
  checkGit,
  checkNode,
  checkTraefik,
  COMPONENT_CHECKS,
} from "./checks";

// ─── Installers ──────────────────────────────────────────────────────────────
export {
  COMPONENT_INSTALLERS,
  installDocker,
  installGit,
  installNode,
  installTraefik,
} from "./installer";

// ─── Manager ─────────────────────────────────────────────────────────────────
export { SystemManager, type SystemManagerOptions } from "./setup";
