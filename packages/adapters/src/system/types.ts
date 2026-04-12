/**
 * System layer types — server setup, prerequisites, and component management.
 *
 * The system layer is ONLY for self-hosted deployments. It takes a
 * bare-metal (or VM) server and prepares it: checking what's installed,
 * installing missing components, and caching the result so we don't
 * re-check on every operation.
 *
 * Key design decisions:
 *   - All commands run through CommandExecutor (local or SSH)
 *   - Setup state is persisted via SetupStateStore (DB or file)
 *   - Installers accept InstallerConfig for values that would
 *     otherwise require interactive input (ACME email, domain, etc.)
 */

// ─── Log streaming ───────────────────────────────────────────────────────────

/** Log entry from system operations — matches LogEntry shape for uniformity. */
export interface SystemLog {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
}

/** Callback for streaming logs during system operations. */
export type SystemLogCallback = (log: SystemLog) => void;

// ─── Component status ────────────────────────────────────────────────────────

export interface SystemComponentDefinition {
  name: string;
  label: string;
  description: string;
  installable: boolean;
  /** core = always shown; infrastructure = shown only when detected */
  category: "core" | "infrastructure";
}

export interface ComponentStatus {
  name: string;
  label: string;
  description: string;
  installable: boolean;
  removable?: boolean;
  removeSupported?: boolean;
  removeBlockedReason?: string;
  installed: boolean;
  version?: string;
  /** Whether the daemon is actively running (Docker, Nginx) */
  running?: boolean;
  /** installed AND running (when applicable) */
  healthy: boolean;
  message: string;
  /** Infrastructure components — shown only when detected on the server */
  optional?: boolean;
}

// ─── Aggregate check result ──────────────────────────────────────────────────

export interface SystemCheckResult {
  components: ComponentStatus[];
  ready: boolean;
  missing: string[];
}

// ─── Features & prerequisites ────────────────────────────────────────────────

/**
 * High-level features. Prerequisites vary by runtime mode.
 *
 * Docker mode:  build → [git, docker], deploy → [docker], routing → [openresty], ssl → [openresty, certbot]
 * Bare mode:    build → [git],         deploy → [stack runtime], routing → [openresty], ssl → [openresty, certbot]
 */
export type Feature = "build" | "deploy" | "routing" | "ssl";

export interface FeatureReadiness {
  feature: Feature;
  ready: boolean;
  missing: ComponentStatus[];
  message: string;
}

export interface PrerequisiteRule {
  feature: Feature;
  requires: string[];
  message: string;
}

// ─── Installer types ─────────────────────────────────────────────────────────

export interface InstallResult {
  component: string;
  success: boolean;
  version?: string;
  error?: string;
}

export interface SetupResult {
  installed: InstallResult[];
  skipped: string[];
  failed: InstallResult[];
  ready: boolean;
}

/**
 * Configuration for installers — pre-collected values that would
 * otherwise require interactive input during installation.
 *
 * The dashboard / CLI collects these from the user BEFORE starting
 * the setup flow, so the installers can run non-interactively.
 */
export interface InstallerConfig {
  /** ACME email for Let's Encrypt certificate provisioning */
  acmeEmail?: string;
  /** Primary domain for the platform */
  domain?: string;
}

// ─── Runtime mode ────────────────────────────────────────────────────────────

export type RuntimeMode = "docker" | "bare";
