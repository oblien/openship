/**
 * Shared build pipeline — clone → install → build.
 *
 * Every runtime adapter uses the same sequence of steps. The only thing
 * that differs is HOW commands get executed (local shell, SSH, oblien
 * API, docker exec). Each adapter provides a `BuildEnvironment` and
 * this module runs the pipeline through it.
 *
 * BuildLogger is the single source of truth for ALL step events and
 * log emission across all runtimes and the deploy phase. One logger
 * instance flows from build.service.ts → adapter → pipeline → deploy.
 */

import type { BuildConfig, BuildStep, LogEntry, LogCallback } from "../types";

// ─── BuildLogger — single source of truth for step + log events ─────────────

/**
 * Unified logger for the entire build→deploy lifecycle.
 *
 * Created once by the service layer and passed through the runtime adapter
 * and build pipeline. Handles structured step events (clone / install /
 * build / deploy) and plain log lines. Every runtime emits through this
 * instead of constructing raw LogEntry objects.
 */
export class BuildLogger {
  constructor(private readonly onLog?: LogCallback) {}

  /** Emit a plain log line. */
  log(message: string, level: LogEntry["level"] = "info"): void {
    this.onLog?.({ timestamp: new Date().toISOString(), message, level });
  }

  /** Emit a step lifecycle event (running / completed / failed / skipped). */
  step(step: BuildStep, status: NonNullable<LogEntry["stepStatus"]>, message: string): void {
    this.onLog?.({
      timestamp: new Date().toISOString(),
      message,
      level: status === "failed" ? "error" : "info",
      step,
      stepStatus: status,
    });
  }

  /**
   * Run a step: emit running → execute → emit completed/failed.
   * Throws on failure so the caller can handle it.
   */
  async runStep(step: BuildStep, label: string, fn: () => Promise<void>): Promise<void> {
    this.step(step, "running", label);
    try {
      await fn();
      this.step(step, "completed", `${label} — done`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.step(step, "failed", `${label} — ${msg}`);
      throw err;
    }
  }

  /** Get the underlying callback for passing to exec / stream functions. */
  get callback(): LogCallback {
    return (entry) => this.onLog?.(entry);
  }
}

// ─── Build environment abstraction ──────────────────────────────────────────

/**
 * Minimal interface each adapter must implement for the build pipeline.
 *
 * This is intentionally tiny — just "run a shell command in the project dir".
 * Each adapter wraps its underlying execution mechanism (executor, oblien
 * exec API, docker exec) behind this interface.
 */
export interface BuildEnvironment {
  /** The working directory where the project is cloned (e.g. "/app", "/tmp/openship/proj-id") */
  readonly projectDir: string;

  /** When true, env vars are set at the container/workspace level — pipeline skips shell export prefix. */
  readonly hasNativeEnv?: boolean;

  /**
   * Pre-build preparation — runs before clone with full log streaming.
   *
   * Each runtime uses this for environment-specific setup:
   *   - Self-hosted: is Docker running? is the build image pullable?
   *   - SSH: is the remote server reachable?
   *   - Cloud: are credentials valid? is there capacity?
   *   - Any: create working directories, validate disk space, etc.
   *
   * For local projects (config.localPath), this is where the runtime
   * transfers source files into the build environment:
   *   - BareRuntime (local):  cp -a (same filesystem)
   *   - BareRuntime (SSH):    tar + pipe over SSH
   *   - CloudRuntime:         tar.gz → Oblien transfer.upload API
   *
   * Receives the logger so output streams to the terminal in real-time.
   * Throw to abort the build with a descriptive error.
   */
  preflight?(config: BuildConfig, logger: BuildLogger): Promise<void>;

  /**
   * Execute a shell command and stream output to log callback.
   * Must reject/throw on non-zero exit code.
   */
  exec(command: string, onLog: LogCallback): Promise<void>;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export interface BuildPipelineResult {
  status: "deploying" | "failed";
  /** Which step failed (undefined if success) */
  failedStep?: BuildStep;
  durationMs: number;
  /** Human-readable error description when status is "failed" */
  errorMessage?: string;
}

/**
 * Run the standard build pipeline: preflight → clone → install → build.
 *
 * Each adapter calls this after setting up its environment.
 * The pipeline is synchronous from the caller's perspective —
 * it resolves when the build completes or fails.
 *
 * The "deploy" step is NOT part of this pipeline — it lives in
 * deploy-pipeline.ts which runs after the build completes.
 */
export async function runBuildPipeline(
  env: BuildEnvironment,
  config: BuildConfig,
  logger: BuildLogger,
): Promise<BuildPipelineResult> {
  const startTime = Date.now();
  let currentStep: BuildStep = "clone";

  const exec = (command: string) => env.exec(command, logger.callback);
  const buildDir = resolveBuildDirectory(env.projectDir, config.rootDirectory);

  // Only show machine specs for cloud builds where resources are allocated
  if (env.hasNativeEnv) {
    const { cpuCores, memoryMb, diskMb } = config.resources;
    logger.log(`Machine: ${cpuCores} CPU · ${memoryMb} MB RAM · ${diskMb} MB Disk`);
  }

  try {
    // ── Pre-build validation ────────────────────────────────────────
    if (env.preflight) {
      await env.preflight(config, logger);
    }

    // ── Step 1: Clone ──────────────────────────────────────────────
    currentStep = "clone";
    if (config.localPath) {
      // Local project — source was already transferred into projectDir
      // by the runtime's preflight. Nothing to clone.
      logger.step("clone", "completed", "Local source ready");
    } else {
      await logger.runStep("clone", `Cloning ${config.repoUrl} (branch: ${config.branch})`, async () => {
        const cloneUrl = injectGitToken(config.repoUrl, config.gitToken);
        if (config.commitSha) {
          await exec(
            `git clone --branch ${sq(config.branch)} ${sq(cloneUrl)} ${sq(env.projectDir)} && cd ${sq(env.projectDir)} && git checkout ${sq(config.commitSha)}`,
          );
        } else {
          await exec(
            `git clone --depth 1 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${sq(env.projectDir)}`,
          );
        }
      });
    }

    // Env prefix for install & build commands — skip when env vars are set natively
    const envPrefix = env.hasNativeEnv
      ? ""
      : Object.entries(config.envVars)
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([k, v]) => `export ${k}=${sq(v)}`)
          .join(" && ");

    const inDir = (cmd: string) => {
      const full = `cd ${sq(buildDir)} && ${cmd}`;
      return envPrefix ? `${envPrefix} && ${full}` : full;
    };

    // ── Step 2: Install ────────────────────────────────────────────
    currentStep = "install";
    if (config.installCommand) {
      await logger.runStep("install", `Installing dependencies (${config.packageManager})`, async () => {
        await exec(inDir(config.installCommand));
      });
    } else {
      logger.step("install", "skipped", "No install command configured");
    }

    // ── Step 3: Build ──────────────────────────────────────────────
    if (config.buildCommand) {
      currentStep = "build";
      await logger.runStep("build", `Building (${config.buildCommand})`, async () => {
        await exec(inDir(config.buildCommand!));
      });
    } else {
      logger.step("build", "skipped", "No build command configured");
    }

    const durationMs = Date.now() - startTime;

    return { status: "deploying", durationMs };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    return { status: "failed", failedStep: currentStep, durationMs, errorMessage };
  }
}

function resolveBuildDirectory(projectDir: string, rootDirectory?: string): string {
  const normalized = rootDirectory?.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") {
    return projectDir;
  }

  return `${projectDir}/${normalized}`;
}

/** Shell-quote a value for use in `sh -c` commands. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
/** Detect log level from a raw log line. Shared across all runtimes. */
export function parseLogLevel(message: string): LogEntry["level"] {
  if (/\b(error|fatal|panic)\b/i.test(message)) return "error";
  if (/\bwarn(ing)?\b/i.test(message)) return "warn";
  return "info";
}

/**
 * Inject a token into an HTTPS git URL for private repo access.
 *
 * Converts `https://github.com/owner/repo.git`
 * into    `https://x-access-token:<token>@github.com/owner/repo.git`
 *
 * Returns the original URL unchanged if no token is provided or
 * the URL is not HTTPS (e.g. ssh://).
 */
export function injectGitToken(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:") return repoUrl;
    url.username = "x-access-token";
    url.password = token;
    return url.toString();
  } catch {
    return repoUrl;
  }
}
