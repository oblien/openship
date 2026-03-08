/**
 * SystemManager — orchestrates server provisioning for self-hosted deployments.
 *
 * Design:
 *   - All commands run through CommandExecutor (local or SSH)
 *   - Setup state is CACHED in a SetupStateStore (DB or file)
 *   - Re-checks only happen when explicitly requested or on first boot
 *   - Installers receive pre-collected config (no interactive prompts)
 *
 * Typical flow:
 *   1. Dashboard shows setup wizard → collects InstallerConfig
 *   2. API calls manager.setup(config, onLog)
 *   3. Manager checks → installs missing → validates → caches state
 *   4. Subsequent operations call manager.isReady() → reads cache
 *   5. Operations call manager.requireFeature("deploy") → fast path
 *
 * Re-verification:
 *   - If 24 hours since last verification, checkAll is re-run
 *   - If any operation fails with a "missing component" error,
 *     the service layer calls manager.invalidate() to clear cache
 */

import type { CommandExecutor, LogEntry } from "../types";
import { checkAll, checkComponents, COMPONENT_CHECKS } from "./checks";
import { COMPONENT_INSTALLERS } from "./installer";
import {
  type SetupStateStore,
  type SetupState,
  type ComponentState,
  FileStateStore,
} from "./state";
import type {
  ComponentStatus,
  Feature,
  FeatureReadiness,
  InstallerConfig,
  InstallResult,
  PrerequisiteRule,
  RuntimeMode,
  SetupResult,
  SystemLogCallback,
  SystemLog,
} from "./types";

// ─── Constants ───────────────────────────────────────────────────────────────

/** How long cached state is considered valid before re-verification (24h). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DOCKER_RULES: PrerequisiteRule[] = [
  { feature: "build", requires: ["git", "docker"], message: "Build requires Git and Docker" },
  { feature: "deploy", requires: ["docker"], message: "Deploy requires Docker" },
  { feature: "routing", requires: ["traefik"], message: "Routing requires Traefik" },
  { feature: "ssl", requires: ["traefik"], message: "SSL requires Traefik with ACME" },
];

const BARE_RULES: PrerequisiteRule[] = [
  { feature: "build", requires: ["git", "node"], message: "Build requires Git and Node.js" },
  { feature: "deploy", requires: ["node"], message: "Deploy requires Node.js" },
  { feature: "routing", requires: ["traefik"], message: "Routing requires Traefik" },
  { feature: "ssl", requires: ["traefik"], message: "SSL requires Traefik with ACME" },
];

const REQUIRED_COMPONENTS: Record<RuntimeMode, string[]> = {
  docker: ["docker", "git", "traefik"],
  bare: ["node", "git", "traefik"],
};

// ─── SystemManager ───────────────────────────────────────────────────────────

export interface SystemManagerOptions {
  /** Command executor (local or SSH) */
  executor: CommandExecutor;
  /**
   * State store for caching setup results.
   * Defaults to FileStateStore if not provided.
   */
  stateStore?: SetupStateStore;
  /** Pre-collected installer configuration */
  installerConfig?: InstallerConfig;
}

export class SystemManager {
  readonly mode: RuntimeMode;
  readonly executor: CommandExecutor;

  private readonly rules: PrerequisiteRule[];
  private readonly required: string[];
  private readonly stateStore: SetupStateStore;
  private readonly installerConfig: InstallerConfig;

  /** In-memory cache to avoid even reading from disk/DB on hot paths. */
  private cachedState: SetupState | null = null;

  constructor(mode: RuntimeMode, opts: SystemManagerOptions) {
    this.mode = mode;
    this.executor = opts.executor;
    this.rules = mode === "docker" ? DOCKER_RULES : BARE_RULES;
    this.required = REQUIRED_COMPONENTS[mode];
    this.stateStore = opts.stateStore ?? new FileStateStore(opts.executor);
    this.installerConfig = opts.installerConfig ?? {};
  }

  // ── Fast-path state queries (cached) ─────────────────────────────────

  /**
   * Is the server fully set up? Reads from cache — never runs checks.
   *
   * Returns false if:
   *   - No cached state (first boot)
   *   - Cached state says setupComplete = false
   *   - Cache is stale (> 24h since last verification)
   *
   * Use this on hot paths (every request). It's essentially free.
   */
  async isReady(): Promise<boolean> {
    const state = await this.loadState();
    if (!state?.setupComplete) return false;

    // If cache is stale, trigger background re-verification
    if (this.isStale(state)) {
      // Don't await — let it run in the background
      this.verify().catch(() => {});
      // Still return true — stale cache is better than blocking
      return true;
    }

    return true;
  }

  /**
   * Get the cached setup state without running any checks.
   * Returns null if no state has been stored yet.
   */
  async getState(): Promise<SetupState | null> {
    return this.loadState();
  }

  // ── Status checks (run on demand) ────────────────────────────────────

  /**
   * Check all registered components — runs actual system commands.
   * Updates the cached state with fresh results.
   */
  async checkAll(): Promise<import("./types").SystemCheckResult> {
    const components = await checkAll(this.executor);

    const missing = components
      .filter((c) => this.required.includes(c.name) && !c.healthy)
      .map((c) => c.name);

    // Update cached state
    await this.updateStateFromChecks(components);

    return { components, ready: missing.length === 0, missing };
  }

  /** Check only the components required for this runtime mode. */
  async checkRequired(): Promise<import("./types").SystemCheckResult> {
    const components = await checkComponents(this.executor, this.required);

    const missing = components.filter((c) => !c.healthy).map((c) => c.name);

    await this.updateStateFromChecks(components);

    return { components, ready: missing.length === 0, missing };
  }

  /**
   * Check whether a specific feature is ready.
   *
   * Fast path: if cached state shows all prerequisites installed,
   * returns immediately without running system commands.
   */
  async checkFeature(feature: Feature): Promise<FeatureReadiness> {
    const rule = this.rules.find((r) => r.feature === feature);
    if (!rule) {
      return { feature, ready: true, missing: [], message: `No prerequisites for "${feature}"` };
    }

    // Try fast path from cached state
    const state = await this.loadState();
    if (state?.setupComplete) {
      const allPresent = rule.requires.every(
        (name) => state.components[name]?.installed,
      );
      if (allPresent) {
        return { feature, ready: true, missing: [], message: `${feature} is ready` };
      }
    }

    // Slow path: actually check the components
    const statuses = await checkComponents(this.executor, rule.requires);
    const unhealthy = statuses.filter((s) => !s.healthy);

    return {
      feature,
      ready: unhealthy.length === 0,
      missing: unhealthy,
      message:
        unhealthy.length === 0
          ? `${feature} is ready`
          : `${rule.message} — missing: ${unhealthy.map((s) => s.name).join(", ")}`,
    };
  }

  /**
   * Require a feature to be ready, or throw.
   *
   * Fast path reads cached state. Use before operations:
   *   await system.requireFeature("deploy");
   */
  async requireFeature(feature: Feature): Promise<void> {
    const readiness = await this.checkFeature(feature);
    if (!readiness.ready) {
      throw new Error(readiness.message);
    }
  }

  // ── Installation ─────────────────────────────────────────────────────

  /**
   * Install a single component with streamed logs.
   */
  async installComponent(
    name: string,
    onLog?: SystemLogCallback,
  ): Promise<InstallResult> {
    const logFn = onLog ?? (() => {});

    const installer = COMPONENT_INSTALLERS[name];
    if (!installer) {
      logFn(info(`No installer available for "${name}"`));
      return { component: name, success: false, error: `No installer for "${name}"` };
    }

    const result = await installer(this.executor, logFn, this.installerConfig);

    // Update state for this component
    if (result.success) {
      await this.markComponentInstalled(name, result.version);
    }

    return result;
  }

  /**
   * Full setup: check → install missing → validate → cache state.
   *
   * This is the main provisioning entrypoint called from the dashboard
   * setup wizard. The InstallerConfig should be pre-collected from the
   * user (ACME email, domain, etc.) before calling this.
   */
  async setup(onLog?: SystemLogCallback, config?: InstallerConfig): Promise<SetupResult> {
    const logFn = onLog ?? (() => {});
    const installerConfig = config ?? this.installerConfig;

    logFn(info(`Starting ${this.mode} server setup...`));
    logFn(info(`Required components: ${this.required.join(", ")}`));

    // Phase 1: Check current state
    logFn(info("Checking installed components..."));
    const initial = await this.checkRequired();

    const alreadyInstalled = initial.components
      .filter((c) => c.healthy)
      .map((c) => c.name);

    if (alreadyInstalled.length > 0) {
      logFn(info(`Already installed: ${alreadyInstalled.join(", ")}`));
    }

    if (initial.ready) {
      logFn(info("All components are already installed — nothing to do"));
      await this.markSetupComplete();
      return { installed: [], skipped: alreadyInstalled, failed: [], ready: true };
    }

    logFn(info(`Missing: ${initial.missing.join(", ")}`));

    // Phase 2: Install each missing component
    const installed: InstallResult[] = [];
    const failed: InstallResult[] = [];

    for (const name of initial.missing) {
      logFn(info(`\n── Installing ${name} ${"─".repeat(50)}`));

      const installer = COMPONENT_INSTALLERS[name];
      if (!installer) {
        const result = { component: name, success: false, error: `No installer for "${name}"` };
        failed.push(result);
        continue;
      }

      const result = await installer(this.executor, logFn, installerConfig);

      if (result.success) {
        installed.push(result);
        await this.markComponentInstalled(name, result.version);
      } else {
        failed.push(result);
        logFn(info(`Failed to install ${name}: ${result.error}`));
      }
    }

    // Phase 3: Validate
    logFn(info("\nValidating installation..."));
    const final = await this.checkRequired();

    if (final.ready) {
      logFn(info("Server setup complete — all components healthy"));
      await this.markSetupComplete();
    } else {
      logFn({
        timestamp: new Date().toISOString(),
        message: `Setup incomplete — still missing: ${final.missing.join(", ")}`,
        level: "warn",
      });
    }

    return {
      installed,
      skipped: alreadyInstalled,
      failed,
      ready: final.ready,
    };
  }

  // ── State management ─────────────────────────────────────────────────

  /**
   * Invalidate the cached state.
   *
   * Call this when an operation fails because a component is missing
   * (e.g., Docker daemon went down). The next `isReady()` call will
   * return false, and `requireFeature()` will re-check.
   */
  async invalidate(): Promise<void> {
    this.cachedState = null;
    await this.stateStore.clear();
  }

  /**
   * Force re-verification: run all checks and update state.
   * Called automatically when cache is stale, or manually by the user.
   */
  async verify(): Promise<import("./types").SystemCheckResult> {
    const result = await this.checkAll();
    return result;
  }

  // ── Utilities ────────────────────────────────────────────────────────

  getRules(): PrerequisiteRule[] {
    return [...this.rules];
  }

  getRequired(): string[] {
    return [...this.required];
  }

  // ── Internal state helpers ───────────────────────────────────────────

  private async loadState(): Promise<SetupState | null> {
    if (this.cachedState) return this.cachedState;
    this.cachedState = await this.stateStore.get();
    return this.cachedState;
  }

  private isStale(state: SetupState): boolean {
    if (!state.lastVerifiedAt) return true;
    const age = Date.now() - new Date(state.lastVerifiedAt).getTime();
    return age > CACHE_TTL_MS;
  }

  private async updateStateFromChecks(
    components: ComponentStatus[],
  ): Promise<void> {
    const existing = (await this.loadState()) ?? this.emptyState();

    for (const c of components) {
      existing.components[c.name] = {
        installed: c.installed,
        version: c.version,
        installedAt: existing.components[c.name]?.installedAt,
      };
    }

    const allRequired = this.required.every(
      (name) => existing.components[name]?.installed,
    );

    existing.setupComplete = allRequired;
    existing.lastVerifiedAt = new Date().toISOString();
    existing.updatedAt = new Date().toISOString();

    this.cachedState = existing;
    await this.stateStore.set(existing);
  }

  private async markComponentInstalled(
    name: string,
    version?: string,
  ): Promise<void> {
    const state = (await this.loadState()) ?? this.emptyState();

    state.components[name] = {
      installed: true,
      version,
      installedAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();

    this.cachedState = state;
    await this.stateStore.set(state);
  }

  private async markSetupComplete(): Promise<void> {
    const state = (await this.loadState()) ?? this.emptyState();
    state.setupComplete = true;
    state.lastVerifiedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();

    this.cachedState = state;
    await this.stateStore.set(state);
  }

  private emptyState(): SetupState {
    return {
      setupComplete: false,
      mode: this.mode,
      components: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function info(message: string): SystemLog {
  return { timestamp: new Date().toISOString(), message, level: "info" };
}
