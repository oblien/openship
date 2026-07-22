/**
 * System layer types - server setup, prerequisites, and component management.
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

import type { PromptUserFn } from "../runtime/deploy-pipeline";

// ─── Log streaming ───────────────────────────────────────────────────────────

/** Log entry from system operations - matches LogEntry shape for uniformity. */
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
  /** Newer version available from the package manager (candidate), if any. */
  availableVersion?: string;
  /** True when `availableVersion` is newer than the installed `version`. */
  updateAvailable?: boolean;
  /** Whether the daemon is actively running (Docker, Nginx) */
  running?: boolean;
  /** installed AND running (when applicable) */
  healthy: boolean;
  message: string;
  /** Infrastructure components - shown only when detected on the server */
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
 * Configuration for installers - pre-collected values that would
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
  /**
   * Pre-accepted authorization to take over ports 80/443 from an existing
   * owner (persisted decision / non-interactive re-ensure). Skips the prompt.
   */
  edgePolicy?: EdgePolicy;
  /**
   * Interactive hold: when the edge ports are held by a foreign proxy and no
   * edgePolicy is set, the installer pauses and asks via this callback — the
   * SAME mechanism as the deploy "a service is already running" prompt. Returns
   * the chosen action id ("override" | "cancel" | "migrate"). Absent + no
   * policy → the installer throws EdgeConflictError rather than guessing.
   */
  promptUser?: PromptUserFn;
}

// ─── Edge (port 80/443) ownership ──────────────────────────────────────────────

/** Recognized reverse proxies that may already own the edge ports. */
export type ProxyKind = "nginx" | "caddy" | "apache" | "traefik" | "haproxy" | "openresty";

/**
 * free    → nothing on 80/443
 * ours    → the edge is our own OpenResty
 * known   → a recognized foreign proxy (migratable)
 * unknown → something holds the port we can't identify (takeover-only)
 */
export type EdgeClassification = "free" | "ours" | "known" | "unknown";

export interface EdgeOccupant {
  port: number;
  pid?: number;
  command?: string;
  rawCommand?: string;
  systemdUnit?: string;
  systemdDescription?: string;
  isDocker?: boolean;
  containerName?: string;
  proxy?: ProxyKind;
  /** true when this is our own OpenResty (never counted as a conflict) */
  managedByOpenship: boolean;
}

export interface EdgeStatus {
  classification: EdgeClassification;
  /** Foreign owners that must be resolved before we can bind 80/443. */
  occupants: EdgeOccupant[];
  /** true for free | ours */
  canProceedClean: boolean;
}

/** A single thing to stop when taking over a port. */
export interface EdgeStopTarget {
  port?: number;
  unit?: string;
  pid?: number;
  container?: string;
  label?: string;
}

/** Explicit, user-accepted authorization to reclaim the edge ports. */
export interface EdgePolicy {
  mode: "takeover";
  stopTargets: EdgeStopTarget[];
}

// ─── Proxy config import (migrate) ──────────────────────────────────────────────

/** A site parsed from an existing proxy's config, normalized for import. */
export interface ImportedSite {
  /** Hostnames this site answers to (server_name / ServerName+Alias / Caddy address). */
  serverNames: string[];
  /** Whether the source served this site over TLS. */
  ssl: boolean;
  /** Where requests go: a reverse-proxy upstream, or a static docroot. */
  target:
    | { kind: "proxy"; url: string }
    | { kind: "static"; root: string };
  /** Existing certificate paths, if the source terminated TLS itself (reusable). */
  tls?: { certPath: string; keyPath: string };
  /** Source config file, for traceability. */
  source?: string;
}

/** Result of scanning one proxy's configuration. */
export interface ProxyScanResult {
  proxy: ProxyKind;
  sites: ImportedSite[];
  /** Anything we couldn't parse/import — surfaced to the user, never silently dropped. */
  warnings: string[];
}

/**
 * The `details` payload of an `edge_conflict` prompt (and the shape surfaced when
 * a non-interactive install halts on an occupied edge). Lets every consumer — the
 * dashboard takeover modal, the CLI preflight, the headless "re-run to take over"
 * message — render the SAME audit data: what proxy holds 80/443 and exactly which
 * sites a migrate would import.
 */
export type EdgeConflictDetails = {
  edge: EdgeStatus;
  /** Sites parsed from the foreign proxy's config (empty for takeover-only proxies). */
  sites: ImportedSite[];
  /** Config the scan couldn't interpret — shown so the operator knows what WON'T migrate. */
  warnings: string[];
};

// ─── Runtime mode ────────────────────────────────────────────────────────────

export type RuntimeMode = "docker" | "bare";
