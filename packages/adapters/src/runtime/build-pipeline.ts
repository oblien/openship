/**
 * Shared build pipeline - clone → install → build.
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
import { safeErrorMessage, packageManagerEnsureCommand } from "@repo/core";
import { sq, injectGitToken, assembleGitClone } from "./git-clone";

// Re-exported for the docker adapters that import these from here.
export { sq, injectGitToken, toGitHubSshUrl, assembleGitClone } from "./git-clone";

// ─── BuildLogger - single source of truth for step + log events ─────────────

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
  log(
    message: string,
    level: LogEntry["level"] = "info",
    meta?: Pick<LogEntry, "serviceName" | "serviceId">,
  ): void {
    this.onLog?.({ timestamp: new Date().toISOString(), message, level, ...meta });
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
      this.step(step, "completed", `${label} - done`);
    } catch (err) {
      const msg = safeErrorMessage(err);
      this.step(step, "failed", `${label} - ${msg}`);
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
 * This is intentionally tiny - just "run a shell command in the project dir".
 * Each adapter wraps its underlying execution mechanism (executor, oblien
 * exec API, docker exec) behind this interface.
 */
export interface BuildEnvironment {
  /** The working directory where the project is cloned (e.g. "/app", "/tmp/openship/proj-id") */
  readonly projectDir: string;

  /** When true, env vars are set at the container/workspace level - pipeline skips shell export prefix. */
  readonly hasNativeEnv?: boolean;

  /**
   * Pre-build preparation - runs before clone with full log streaming.
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

  /**
   * Write a SECRET file (0600) to the build host WITHOUT its bytes appearing in
   * the streamed log — used for the SSH private key + known_hosts in ssh clone
   * mode. Runtimes that can't do this safely (no out-of-band write) omit it;
   * the clone step then refuses SSH auth with an actionable error rather than
   * risk leaking the key through `exec`.
   */
  writeSecretFile?(path: string, content: string): Promise<void>;
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
 * The pipeline is synchronous from the caller's perspective -
 * it resolves when the build completes or fails.
 *
 * The "deploy" step is NOT part of this pipeline - it lives in
 * deploy-pipeline.ts which runs after the build completes.
 */
export async function runBuildPipeline(
  env: BuildEnvironment,
  config: BuildConfig,
  logger: BuildLogger,
): Promise<BuildPipelineResult> {
  // Initialized here so the catch below always has a baseline (covers a
  // failure during prepare). RESET after prepare so the reported build
  // duration excludes one-time server provisioning.
  let startTime = Date.now();
  let currentStep: BuildStep = "prepare";

  const exec = (command: string) => env.exec(command, logger.callback);
  const buildDir = resolveBuildDirectory(env.projectDir, config.rootDirectory);

  // Only show machine specs for cloud builds where resources are allocated
  if (env.hasNativeEnv) {
    const { cpuCores, memoryMb, diskMb } = config.resources;
    logger.log(`Machine: ${cpuCores} CPU · ${memoryMb} MB RAM · ${diskMb} MB Disk`);
  }

  try {
    // ── Prepare: one-time server provisioning (toolchain install, source
    // transfer). Shown as its own phase and EXCLUDED from build time — the
    // build clock starts only once the server is ready. Near-instant on
    // subsequent deploys (tools already present).
    if (env.preflight) {
      await logger.runStep("prepare", "Preparing server", async () => {
        await env.preflight!(config, logger);
      });
    }

    // Build clock starts here — AFTER prepare — so toolchain provisioning
    // doesn't inflate the build duration.
    startTime = Date.now();

    // ── Step 1: Clone ──────────────────────────────────────────────
    currentStep = "clone";
    if (config.localPath || config.sourceStaged) {
      // Local project (source transferred into projectDir by the runtime's
      // preflight) OR folder-upload (source already staged in the workspace).
      // Either way there is nothing to clone.
      logger.step("clone", "completed", "Source ready");
    } else {
      await logger.runStep(
        "clone",
        `Cloning ${config.repoUrl} (branch: ${config.branch})`,
        async () => {
          // Two auth modes for the clone:
          //
          //   Default (token / public): the token (if any) is injected into the
          //   clone URL, and `-c credential.helper=` DISABLES any host-level
          //   helper (osxkeychain, libsecret) so the URL token is the only auth.
          //
          //   Relay (desktop-only, config.gitCredentialHelperPath set): a plain
          //   URL + a remote credential-helper script (reached via GIT_CONFIG_*,
          //   git >=2.31, no ~/.gitconfig write) that fetches the operator's gh
          //   token on demand over a reverse tunnel — so NO token lands in the
          //   remote .git/config. Here we must NOT disable credential.helper:
          //   the helper IS the auth.
          //
          // Shared GIT_ENV bits:
          //   GIT_TERMINAL_PROMPT=0 — never block on an interactive prompt.
          //   GIT_ASKPASS=/bin/echo — backstop so a missing credential fails
          //     fast (token mode only; the relay supplies creds via the helper).
          //   --progress — keep the log stream alive on non-tty build pipes.
          // SSH mode (per-server key / deploy key): write the 0600 key +
          // known_hosts OUT OF BAND (via writeSecretFile, never through `exec`,
          // so the key bytes never reach the log) and clone over git@github.com.
          // Requires a runtime that can write a secret file; otherwise refuse
          // rather than risk leaking the key.
          let sshFiles: { keyFile: string; knownHostsFile: string } | undefined;
          let sshCleanup: string | null = null;
          if (config.gitSsh) {
            if (!env.writeSecretFile) {
              throw new Error(
                "SSH-based GitHub auth isn't supported on this build runtime — use a token or the tunnel relay.",
              );
            }
            const dir = `${env.projectDir}.gitssh`;
            const keyFile = `${dir}/id`;
            const knownHostsFile = `${dir}/known_hosts`;
            await exec(`mkdir -p ${sq(dir)} && chmod 700 ${sq(dir)}`);
            await env.writeSecretFile(keyFile, config.gitSsh.privateKey);
            await env.writeSecretFile(knownHostsFile, config.gitSsh.knownHosts);
            await exec(`chmod 600 ${sq(keyFile)}`);
            sshFiles = { keyFile, knownHostsFile };
            sshCleanup = `rm -rf ${sq(dir)}`;
          }

          // Centralized clone assembly (token / relay / ssh) — see git-clone.ts.
          const { cloneUrl, gitEnv: GIT_ENV, credFlag: CRED } = assembleGitClone({
            repoUrl: config.repoUrl,
            gitToken: config.gitToken,
            gitTokenUsername: config.gitTokenUsername,
            gitCredentialHelperPath: config.gitCredentialHelperPath,
            ssh: sshFiles,
          });

          try {
            if (config.commitSha) {
              // Depth 50 strikes a balance: deep enough to reach the
              // commit for the vast majority of rollbacks, but still
              // far cheaper than a full history fetch. Older rollback
              // targets fall through to the unshallow fallback below.
              try {
                await exec(
                  `${GIT_ENV} git ${CRED} clone --progress --depth 50 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${sq(env.projectDir)} && cd ${sq(env.projectDir)} && git ${CRED} -c advice.detachedHead=false checkout ${sq(config.commitSha)}`,
                );
              } catch {
                // Fallback: SHA not in the shallow window (rollback
                // targets more than 50 commits old). Unshallow the
                // clone and retry the checkout.
                logger.log(
                  `Checkout of ${config.commitSha} failed inside the depth-50 clone; running git fetch --unshallow and retrying.`,
                  "warn",
                );
                await exec(
                  `cd ${sq(env.projectDir)} && ${GIT_ENV} git ${CRED} fetch --progress --unshallow && git ${CRED} -c advice.detachedHead=false checkout ${sq(config.commitSha)}`,
                );
              }
            } else {
              await exec(
                `${GIT_ENV} git ${CRED} clone --progress --depth 1 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${sq(env.projectDir)}`,
              );
            }
          } finally {
            // Always remove the ephemeral SSH key material, success or fail.
            if (sshCleanup) await exec(sshCleanup).catch(() => {});
          }
        },
      );
    }

    // Env prefix for install & build commands - skip when env vars are set natively
    const envPrefix = env.hasNativeEnv
      ? ""
      : Object.entries(config.envVars)
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([k, v]) => `export ${k}=${sq(v)}`)
          .join(" && ");

    // Put the project's locally-installed CLIs on PATH so a build/install command
    // that invokes a dependency binary directly — e.g. a vercel.json
    // `buildCommand: "vite build"`, or `tsc` / `next` / `astro` — resolves it,
    // mirroring how Vercel / Netlify / npm-scripts prepend `node_modules/.bin`.
    // Both the build dir and the repo root are added (monorepos hoist deps up).
    // Scoped to JS package managers: Go/Rust/Python/etc. have no `node_modules`,
    // so the prefix would only add non-existent dirs to PATH.
    const JS_PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);
    const binPathExport = JS_PACKAGE_MANAGERS.has(config.packageManager)
      ? `export PATH=${sq(`${buildDir}/node_modules/.bin`)}:${sq(`${env.projectDir}/node_modules/.bin`)}:"$PATH"`
      : "";

    const inDir = (cmd: string) => {
      const full = `cd ${sq(buildDir)} && ${cmd}`;
      const prefix = [envPrefix, binPathExport].filter(Boolean).join(" && ");
      return prefix ? `${prefix} && ${full}` : full;
    };

    // Ensure the detected package manager is on PATH before the first pnpm/yarn
    // invocation (corepack for pnpm/yarn; no-op for npm/bun/non-node) — fixes
    // "pnpm: not found". `corepack enable` persists the shim to disk, so once
    // install has run the build step inherits it; only prepend it to build when
    // install was skipped (build-command-only config).
    const pmEnsure = packageManagerEnsureCommand(config.packageManager);

    // ── Step 2: Install ────────────────────────────────────────────
    currentStep = "install";
    if (config.installCommand) {
      const installCmd = pmEnsure ? `${pmEnsure} && ${config.installCommand}` : config.installCommand;
      await logger.runStep(
        "install",
        `Installing dependencies (${config.packageManager})`,
        async () => {
          await exec(inDir(installCmd));
        },
      );
    } else {
      logger.step("install", "skipped", "No install command configured");
    }

    // ── Step 3: Build ──────────────────────────────────────────────
    if (config.buildCommand) {
      currentStep = "build";
      const buildCmd =
        pmEnsure && !config.installCommand
          ? `${pmEnsure} && ${config.buildCommand}`
          : config.buildCommand;
      await logger.runStep("build", `Building (${config.buildCommand})`, async () => {
        await exec(inDir(buildCmd));
      });
    } else {
      logger.step("build", "skipped", "No build command configured");
    }

    const durationMs = Date.now() - startTime;

    return { status: "deploying", durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = safeErrorMessage(err);

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
/** Detect log level from a raw log line. Shared across all runtimes. */
export function parseLogLevel(message: string): LogEntry["level"] {
  if (/\b(error|fatal|panic)\b/i.test(message)) return "error";
  if (/\bwarn(ing)?\b/i.test(message)) return "warn";
  return "info";
}

/**
 * Detect a kernel OOM / SIGKILL signature in a build's streamed output
 * and produce a one-line, user-facing hint. Returns null when no such
 * signature is present.
 *
 * Why: when the kernel OOM-kills a node/bun build, the parent process
 * usually exits with a plain non-zero code (often 1), losing the signal
 * info - operators see "Command failed with exit code 1" and have no
 * idea the VPS ran out of memory. The output stream still carries
 * the smoking gun ("SIGKILL", "Killed", "out of memory") right before
 * the crash. We surface it.
 */
export function detectBuildKillHint(output: string): string | null {
  if (!output) return null;
  const tail = output.slice(-4096);
  if (/\bsigkill\b|\bKilled\b|out of memory|JavaScript heap out of memory|Allocation failed/i.test(tail)) {
    return (
      "Build process was killed - typically because the target ran out of memory during the build. " +
      "Increase RAM on the target, add swap, or build locally and ship the dist."
    );
  }
  return null;
}

