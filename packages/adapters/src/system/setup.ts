/**
 * SystemManager - orchestrates server provisioning for self-hosted deployments.
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

import type { CommandExecutor, LogEntry, ProvisionLock } from "../types";
import { checkAll, checkComponents, COMPONENT_CHECKS } from "./checks";
import { COMPONENT_INSTALLERS } from "./installer";
import {
  REMOTE_SERVER_REQUIRED_COMPONENTS,
  resolveSystemComponentInstallPlan,
} from "./requirements";
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
  SystemCheckResult,
  SystemLogCallback,
  SystemLog,
} from "./types";
// ─── Constants ───────────────────────────────────────────────────────────────

/** How long cached state is considered valid before re-verification (24h). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve prerequisite rules for a given runtime mode.
 *
 * Runtime mode determines how applications run, but the managed Edge is a
 * container in both modes. Its Docker dependency comes from the shared system
 * component graph rather than being repeated in these feature rules.
 *
 * "Edge" is ONE component (the openship-edge container: OpenResty + Lua +
 * certbot). It used to be two rows, `openresty` and `certbot`, for one artifact
 * that is installed, checked and removed as a unit.
 *
 * Note: Node.js / Go / Python / etc. are NOT system prerequisites.
 * They are installed on-demand by the toolchain layer (ensureToolchain)
 * based on what each stack's language requires.
 */
function resolveRules(mode: RuntimeMode): PrerequisiteRule[] {
  if (mode === "docker") {
    return [
      { feature: "build", requires: ["git", "docker"], message: "Build requires Git and Docker" },
      { feature: "deploy", requires: ["docker"], message: "Deploy requires Docker" },
      { feature: "routing", requires: ["edge"], message: "Routing requires the edge" },
      { feature: "ssl", requires: ["edge"], message: "SSL requires the edge" },
    ];
  }

  // bare mode - language runtimes handled per-stack by toolchain layer
  return [
    { feature: "build", requires: ["git"], message: "Build requires Git" },
    { feature: "routing", requires: ["edge"], message: "Routing requires the edge" },
    { feature: "ssl", requires: ["edge"], message: "SSL requires the edge" },
  ];
}

/** Resolve the complete prerequisite set for a managed deployment target. */
function resolveRequired(): string[] {
  return resolveSystemComponentInstallPlan([...REMOTE_SERVER_REQUIRED_COMPONENTS, "edge"]);
}

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
  /**
   * Serializes the check→install→revalidate section across concurrent deploys
   * on the same server. Omitted → runs unlocked (single-deploy / tests).
   */
  provisionLock?: ProvisionLock;
  /**
   * Treat every feature as already provisioned — `ensureFeature`/`ensureComponents`
   * become no-ops. Used when openship runs containerized (compose): docker is the
   * mounted socket and the edge is the `openship-edge` image, so the api must NOT
   * try to install anything on its own container/host.
   */
  assumeInstalled?: boolean;
}

export class SystemManager {
  readonly mode: RuntimeMode;
  readonly executor: CommandExecutor;

  private readonly rules: PrerequisiteRule[];
  private readonly required: string[];
  private readonly stateStore: SetupStateStore;
  private readonly installerConfig: InstallerConfig;
  private readonly provisionLock?: ProvisionLock;
  private readonly assumeInstalled: boolean;

  /** In-memory cache to avoid even reading from disk/DB on hot paths. */
  private cachedState: SetupState | null = null;

  /** In-flight background re-verification, if any (see kickBackgroundVerify). */
  private verifyInFlight: Promise<unknown> | null = null;

  constructor(mode: RuntimeMode, opts: SystemManagerOptions) {
    this.mode = mode;
    this.executor = opts.executor;
    this.rules = resolveRules(mode);
    this.required = resolveRequired();
    this.stateStore = opts.stateStore ?? new FileStateStore(opts.executor);
    this.installerConfig = opts.installerConfig ?? {};
    this.provisionLock = opts.provisionLock;
    this.assumeInstalled = opts.assumeInstalled ?? false;
  }

  // ── Fast-path state queries (cached) ─────────────────────────────────

  /**
   * Is the server fully set up? Reads from cache - never runs checks.
   *
   * Returns false if:
   *   - No cached state (first boot)
   *   - Cached state says setupComplete = false
   *
   * A stale cache (> 24h) still answers true, with a re-verification kicked behind
   * the call — this must never block.
   *
   * Use this on hot paths (every request). It's essentially free.
   */
  async isReady(): Promise<boolean> {
    const state = await this.loadState();
    if (!state?.setupComplete) return false;

    // Stale cache beats blocking a request: answer from cache, re-verify behind it.
    if (this.isStale(state)) this.kickBackgroundVerify();

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
   * Check all registered components - runs actual system commands.
   * Updates the cached state with fresh results.
   */
  async checkAll(): Promise<SystemCheckResult> {
    const components = await checkAll(this.executor);

    const missing = components
      .filter((c) => this.required.includes(c.name) && !c.healthy)
      .map((c) => c.name);

    // Update cached state
    await this.updateStateFromChecks(components);

    return { components, ready: missing.length === 0, missing };
  }

  /** Check only the components required for this runtime mode. */
  async checkRequired(): Promise<SystemCheckResult> {
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
    // Docker-edge / assume-installed mode: the edge's binaries live in the edge
    // container, not this api image. Treat every feature as ready —
    // mirroring ensureFeature's short-circuit — so requireFeature() doesn't
    // hard-fail a docker-edge deploy probing this image for a binary it never has.
    if (this.assumeInstalled) {
      return { feature, ready: true, missing: [], message: `${feature} assumed installed` };
    }
    const rule = this.rules.find((r) => r.feature === feature);
    if (!rule) {
      return { feature, ready: true, missing: [], message: `No prerequisites for "${feature}"` };
    }

    const required = resolveSystemComponentInstallPlan(rule.requires);

    // Try fast path from cached state
    const state = await this.loadState();
    if (state?.setupComplete) {
      const allPresent = required.every(
        (name) => state.components[name]?.healthy === true,
      );
      if (allPresent) {
        // Same staleness policy as isReady(): serve the cached answer, kick the 24h
        // re-verify behind it. Without this the cache is authoritative FOREVER on a
        // box reached only through ensureFeature/requireFeature — nothing outside
        // this class calls isReady()/verify(), so a docker that was removed after
        // provisioning would never be re-probed and ensureFeature would never
        // self-heal it.
        if (this.isStale(state)) this.kickBackgroundVerify();
        return { feature, ready: true, missing: [], message: `${feature} is ready` };
      }
    }

    // Slow path: actually check the components. Deliberately NOT persisted — this
    // checked one feature's subset, and freshness is one global stamp (see
    // updateStateFromChecks).
    const statuses = await checkComponents(this.executor, required);
    const unhealthy = statuses.filter((s) => !s.healthy);

    return {
      feature,
      ready: unhealthy.length === 0,
      missing: unhealthy,
      message:
        unhealthy.length === 0
          ? `${feature} is ready`
          : `${rule.message} - missing: ${unhealthy.map((s) => s.name).join(", ")}`,
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

  /**
   * Ensure a feature is ready: check prerequisites, install missing ones, re-validate.
   *
   * This is the operational path used by deploy/build flows when they can safely
   * self-heal missing system components instead of hard-failing immediately.
   */
  async ensureFeature(
    feature: Feature,
    onLog?: SystemLogCallback,
    config?: InstallerConfig,
  ): Promise<void> {
    // Containerized (compose): prerequisites are provided by the stack (docker
    // socket + the openship-edge image), not installable from inside the api — skip.
    if (this.assumeInstalled) return;

    const logFn = onLog ?? (() => {});
    const installerConfig = config ?? this.installerConfig;

    const readiness = await this.checkFeature(feature);
    if (readiness.ready) return;

    await this.ensureNamedComponents(
      readiness.missing.map((component) => component.name),
      logFn,
      installerConfig,
      `Checking required system components for ${feature}...`,
      (names) => `${this.rules.find((rule) => rule.feature === feature)?.message ?? feature} - missing: ${names.join(", ")}`,
    );
  }

  async ensureComponents(
    names: string[],
    onLog?: SystemLogCallback,
    config?: InstallerConfig,
  ): Promise<void> {
    if (this.assumeInstalled) return;
    const logFn = onLog ?? (() => {});
    const installerConfig = config ?? this.installerConfig;
    await this.ensureNamedComponents(
      names,
      logFn,
      installerConfig,
      "Checking required system components...",
      (missingNames) => `Required components are still not ready: ${missingNames.join(", ")}`,
    );
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
    return this.runInstaller(name, logFn, this.installerConfig);
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
      logFn(info("All components are already installed - nothing to do"));
      await this.markSetupComplete();
      return { installed: [], skipped: alreadyInstalled, failed: [], ready: true };
    }

    logFn(info(`Missing: ${initial.missing.join(", ")}`));

    // Phase 2: Install each missing component
    const { installed, failed } = await this.installMany(
      initial.missing,
      logFn,
      installerConfig,
      false,
    );

    // Phase 3: Validate
    logFn(info("\nValidating installation..."));
    const final = await this.checkRequired();

    if (final.ready) {
      logFn(info("Server setup complete - all components healthy"));
      await this.markSetupComplete();
    } else {
      logFn({
        timestamp: new Date().toISOString(),
        message: `Setup incomplete - still missing: ${final.missing.join(", ")}`,
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
  async verify(): Promise<SystemCheckResult> {
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

  /**
   * Run the staleness re-verification behind the caller — one at a time.
   *
   * The dedup is the point: a single deploy gates several features in a row, and
   * every request calls isReady(), so an un-guarded kick would stack one full
   * checkAll per call — each fanning 4 concurrent probes onto the same ssh
   * connection, against sshd's MaxSessions (see mapWithConcurrency in checks.ts).
   */
  private kickBackgroundVerify(): void {
    if (this.verifyInFlight) return;
    this.verifyInFlight = this.verify()
      .catch(() => {})
      .finally(() => {
        this.verifyInFlight = null;
      });
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
        running: c.running,
        healthy: c.healthy,
        installedAt: existing.components[c.name]?.installedAt,
      };
    }

    const allRequired = this.required.every(
      (name) => existing.components[name]?.installed,
    );

    existing.setupComplete = allRequired;
    // lastVerifiedAt is ONE stamp for the whole state, so only a check that covered
    // every required component may move it. Stamping it from a partial check —
    // ensureFeature("deploy") probes docker alone — would un-stale components nobody
    // looked at and permanently silence the 24h re-verify for all of them.
    // A required component with no registered check can never be covered, so it must
    // not hold the stamp hostage — that would leave the state stale forever.
    const checked = new Set(components.map((c) => c.name));
    const coveredAll = this.required.every(
      (name) => checked.has(name) || !COMPONENT_CHECKS[name],
    );
    if (coveredAll) {
      existing.lastVerifiedAt = new Date().toISOString();
    }
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
      healthy: false,
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

  private async runInstaller(
    name: string,
    logFn: SystemLogCallback,
    installerConfig: InstallerConfig,
  ): Promise<InstallResult> {
    const installer = COMPONENT_INSTALLERS[name];
    if (!installer) {
      logFn(info(`No installer available for "${name}"`));
      return { component: name, success: false, error: `No installer for "${name}"` };
    }

    const result = await installer(this.executor, logFn, installerConfig);
    if (result.success) {
      await this.markComponentInstalled(name, result.version);
    }
    return result;
  }

  private async installMany(
    names: string[],
    logFn: SystemLogCallback,
    installerConfig: InstallerConfig,
    stopOnFailure: boolean,
  ): Promise<{ installed: InstallResult[]; failed: InstallResult[] }> {
    const installed: InstallResult[] = [];
    const failed: InstallResult[] = [];

    for (const name of names) {
      logFn(info(`\n── Installing ${name} ${"─".repeat(50)}`));

      const result = await this.runInstaller(name, logFn, installerConfig);
      if (result.success) {
        installed.push(result);
        continue;
      }

      failed.push(result);
      logFn(info(`Failed to install ${name}: ${result.error}`));
      if (stopOnFailure) break;
    }

    return { installed, failed };
  }

  private async ensureNamedComponents(
    names: string[],
    logFn: SystemLogCallback,
    installerConfig: InstallerConfig,
    heading: string,
    errorMessage: (missingNames: string[]) => string,
  ): Promise<void> {
    const required = resolveSystemComponentInstallPlan(names);
    // The check→install→revalidate below is a check-then-act on server-global
    // state (apt/dpkg, systemd units, port 80, /etc config, the state file).
    // Serialize the WHOLE section — including the "already healthy, skip" check —
    // so concurrent deploys to the same server can't both install or clobber.
    const critical = async () => {
      const statuses = await checkComponents(this.executor, required);
      const missing = statuses.filter((status) => !status.healthy);
      if (missing.length === 0) {
        await this.updateStateFromChecks(statuses);
        return;
      }

      logFn(info(heading));
      logFn(info(`Missing: ${missing.map((component) => component.name).join(", ")}`));

      const { failed } = await this.installMany(
        missing.map((component) => component.name),
        logFn,
        installerConfig,
        true,
      );

      if (failed.length > 0) {
        throw new Error(failed[0].error ?? `Failed to install ${failed[0].component}`);
      }

      const recheck = await checkComponents(this.executor, required);
      await this.updateStateFromChecks(recheck);

      const unhealthy = recheck.filter((status) => !status.healthy);
      if (unhealthy.length > 0) {
        throw new Error(errorMessage(unhealthy.map((status) => status.name)));
      }
    };

    return this.provisionLock ? this.provisionLock.run(critical) : critical();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function info(message: string): SystemLog {
  return { timestamp: new Date().toISOString(), message, level: "info" };
}
