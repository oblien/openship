/**
 * Bare runtime - lightweight process management without Docker.
 *
 * Runs applications directly on the target server via shell commands.
 * All operations go through a CommandExecutor, so the bare runtime
 * works identically on the local machine and on remote servers via SSH.
 *
 * Architecture:
 *   BUILD  → BareRuntime owns clone/install/build (via executor + build-pipeline)
 *   DEPLOY → delegated to a ProcessSupervisor (systemd on Linux, nohup on macOS)
 *
 * The supervisor is auto-detected at construction time based on the
 * target machine's capabilities - no per-deploy branching.
 *
 * buildStrategy support:
 *   "server" → clone + build on the target machine (via executor)
 *   "local"  → clone + build on the API host, then transfer output to target
 */

import type {
  BuildConfig,
  CommandExecutor,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
} from "../types";

import { LocalExecutor, wrapLocalBuildCommand } from "../system/executor";
import { ensureOwnedDir } from "../system/elevated-executor";
import { execReliable } from "../system/remote-journal";
import { STACKS, appVolumeTargets, buildOutputTransferExcludes, safeErrorMessage, missingOutputDirectoryMessage, packageManagerEnsureCommand, type StackId, type StackDefinition } from "@repo/core";
import { checkToolchainForStack, installTools } from "../toolchain";
import type {
  RuntimeAdapter,
  RuntimeCapability,
  DeploymentRef,
  RollbackInput,
  MakeActiveResult,
} from "./types";
import { BuildCancelledError, BuildLogger, detectBuildKillHint, runBuildPipeline, sq, type BuildEnvironment } from "./build-pipeline";
import { runLocalBuild } from "./local-build";
import { transferLocalDirectory } from "./transfer";
import { prepareStackOutput, resolveProjectDir, resolveStaticOutputPath } from "./stack-output";
import type { ProcessSupervisor } from "./supervisor/types";
import { detectSupervisor } from "./supervisor/detect";
import { probeListeningPort } from "./port-conflict";

/** Parent of a POSIX path on the TARGET machine — node:path would resolve
 *  against the local platform's separator, which is wrong over SSH from Windows. */
function parentPath(path: string): string {
  const idx = path.replace(/\/+$/, "").lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface BareSystemManager {
  ensureComponents(names: string[], onLog?: (log: LogEntry) => void): Promise<void>;
}

export interface BareRuntimeOptions {
  /** Base directory for project working directories (default: /opt/openship) */
  workDir?: string;
  /** Max time for build commands in ms (default: 10 min) */
  buildTimeout?: number;
  /**
   * Command executor - local or SSH.
   *
   * When provided, ALL commands and file operations are routed through
   * the executor. This is what makes bare runtime work on remote servers.
   * When omitted, a LocalExecutor is created automatically (same machine).
   */
  executor?: CommandExecutor;
  /** Optional system manager for ensuring remote runtime prerequisites. */
  systemManager?: BareSystemManager;
}

const DEFAULT_WORK_DIR = "/opt/openship";
const DEFAULT_BUILD_TIMEOUT = 10 * 60 * 1000;

/**
 * Dedicated base for static doc-roots — deliberately separate from
 * DEFAULT_WORK_DIR. Static sites build in a Docker sandbox and serve their
 * extracted files from here; this is the ONE directory shared into the edge
 * container (bind-mounted at the same path) in docker-edge mode, so it must
 * NOT contain server bundles, node_modules, or release secrets. A static-serve
 * BareRuntime is constructed with `workDir = STATIC_RELEASE_BASE` so its
 * releases/.builds subdirs confine here and promote stays same-FS.
 */
export const STATIC_RELEASE_BASE = "/opt/openship/static";



// ─── Bare runtime ────────────────────────────────────────────────────────────

export class BareRuntime implements RuntimeAdapter {
  readonly name = "bare";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "deploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "runtimeLogs",
    "streamLogs",
    // Real measurements now (cgroup → /proc → ps, via the supervisor), so this can
    // finally be declared. It was absent while getUsage returned a zeros stub — but
    // nothing checked, so callers rendered those zeros as data. Anything reading
    // usage should gate on supports("usage") rather than trust the numbers.
    // Network is the one gap: per-process rx/tx needs eBPF or a netns, so it stays 0.
    "usage",
    "containerIp",
    "rollback",
    // The release dir + supervisor unit survive a redeploy, so restoring a
    // past release really is an in-place unit swap (see makeActive).
    "unitRestore",
    "inContainerExec",
  ]);

  private readonly workDir: string;
  private readonly buildTimeout: number;
  private executor: CommandExecutor;
  private readonly systemManager: BareSystemManager | null;
  /** True if we created the executor ourselves (must dispose on cleanup) */
  private readonly ownsExecutor: boolean;
  /** Track active builds by sessionId for cancellation */
  private readonly activeBuilds = new Map<string, AbortController>();
  /** Process lifecycle delegate - resolved lazily on first deploy/stop/etc. */
  private _supervisor: ProcessSupervisor | null = null;
  private _supervisorPromise: Promise<ProcessSupervisor> | null = null;

  constructor(opts?: BareRuntimeOptions) {
    this.workDir = opts?.workDir ?? DEFAULT_WORK_DIR;
    this.buildTimeout = opts?.buildTimeout ?? DEFAULT_BUILD_TIMEOUT;

    if (opts?.executor) {
      this.executor = opts.executor;
      this.ownsExecutor = false;
    } else {
      this.executor = new LocalExecutor();
      this.ownsExecutor = true;
    }

    this.systemManager = opts?.systemManager ?? null;
  }

  /** The underlying command executor (local or SSH). Exposed so the
   *  backup subsystem's bare executor can stream commands over the same
   *  connection (mirrors how DockerRuntime exposes its client). */
  get commandExecutor(): CommandExecutor {
    return this.executor;
  }

  /** A bare deployment is a host process, so "inside the instance" == the host.
   *  The host executor already sees the process's listeners (shared netns). */
  async inContainerExecutor(): Promise<CommandExecutor> {
    return this.executor;
  }

  /** Get or lazily initialise the process supervisor. */
  private async supervisor(): Promise<ProcessSupervisor> {
    if (this._supervisor) return this._supervisor;
    if (!this._supervisorPromise) {
      this._supervisorPromise = detectSupervisor(this.executor, this.workDir).then((s) => {
        this._supervisor = s;
        return s;
      });
    }
    return this._supervisorPromise;
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    if (this.ownsExecutor) {
      await this.executor.dispose();
    }
  }

  // ─── Path helpers ────────────────────────────────────────────────────

  private projectDir(projectId: string): string {
    return `${this.workDir}/${projectId}`;
  }

  private buildDir(sessionId: string): string {
    return `${this.workDir}/.builds/${sessionId}`;
  }

  private releaseDir(deploymentId: string): string {
    return `${this.workDir}/releases/${deploymentId}`;
  }

  /** Per-project directory holding the paths that must survive a release swap.
   *  The `shared/` half of the Capistrano layout `releases/` already implements. */
  private sharedDir(projectId: string): string {
    return `${this.workDir}/shared/${projectId}`;
  }

  /**
   * Repoint the release's persistent paths at `shared/`, so a redeploy doesn't
   * take the app's data with the old release.
   *
   * Docker gets this from a volume; bare has no mount to hang it on, so the
   * equivalent is the deploy convention: keep the state outside the release tree
   * and symlink it in. The first release that ships the path SEEDS the shared
   * copy from it — frameworks ship a skeleton there (Laravel's `storage/` has
   * `framework/cache`, `framework/sessions`, …) and an app handed an empty
   * directory instead would fail on write.
   *
   * Best-effort per path: a box without the shared dir writable is a storage
   * problem to report, not a reason to fail an otherwise good release.
   */
  private async linkPersistentPaths(
    releaseDir: string,
    projectId: string,
    volumes: string[] | undefined,
    log?: LogCallback,
  ): Promise<void> {
    const targets = appVolumeTargets(volumes ?? []);
    if (targets.length === 0) return;

    const shared = this.sharedDir(projectId);
    for (const relative of targets) {
      const sharedPath = `${shared}/${relative}`;
      const releasePath = `${releaseDir}/${relative}`;
      try {
        if (!(await this.executor.exists(sharedPath))) {
          await this.executor.mkdir(parentPath(sharedPath));
          if (await this.executor.exists(releasePath)) {
            await this.executor.exec(`cp -a ${sq(releasePath)} ${sq(sharedPath)}`);
          } else {
            await this.executor.mkdir(sharedPath);
          }
        }
        await this.executor.rm(releasePath);
        await this.executor.mkdir(parentPath(releasePath));
        // -n so a pre-existing symlink is replaced rather than followed into
        // (which would nest shared/storage/storage on the second deploy).
        await this.executor.exec(`ln -sfn ${sq(sharedPath)} ${sq(releasePath)}`);
        log?.({
          timestamp: new Date().toISOString(),
          message: `Persistent path ${relative} → ${sharedPath}\n`,
          level: "info",
        });
      } catch (err) {
        log?.({
          timestamp: new Date().toISOString(),
          message: `Could not persist ${relative}: ${safeErrorMessage(err)}\n`,
          level: "warn",
        });
      }
    }
  }

  private async promoteBuildArtifact(
    artifactPath: string,
    deploymentId: string,
    previousDeploymentId?: string,
  ): Promise<string> {
    const releaseDir = this.releaseDir(deploymentId);
    if (artifactPath === releaseDir) return releaseDir;

    await ensureOwnedDir(this.executor, `${this.workDir}/releases`);
    await this.executor.rm(releaseDir);

    // Capistrano-style hard-link dedup: when we know the previous
    // release exists, stage the new one with `rsync --link-dest`. Files
    // byte-identical to the previous release share inodes (zero extra
    // disk); changed files get a fresh copy. For Node projects this is
    // a massive win — `node_modules` typically changes very little
    // between deploys, so 5 retained releases cost ~1× node_modules
    // on disk instead of 5×.
    //
    // Safety: rsync's default behavior on a change is replace-by-rename
    // (write `.tmp`, then atomic rename). That gives the changed file a
    // NEW inode — the hard-link to the previous release is broken, so
    // the old release stays bit-for-bit identical to what it was. We
    // pass --delete so files removed in the new build vanish from the
    // new release (but stay in the old, again because of the inode
    // split). Net effect: each release is a self-contained snapshot.
    const previousReleaseDir = previousDeploymentId
      ? this.releaseDir(previousDeploymentId)
      : undefined;
    // Release staging is the deploy COMMIT — journal it exactly-once so a
    // mid-copy SSH drop re-attaches and harvests instead of re-running (and,
    // for the non-idempotent `mv`, never double-applies). rsync and the mv
    // fallback use distinct opIds so the fallback can't collide with a
    // partially-recorded rsync op.
    if (previousReleaseDir && (await this.executor.exists(previousReleaseDir))) {
      try {
        await execReliable(
          this.executor,
          `deploy:${deploymentId}:promote-rsync`,
          `rsync -a --delete --link-dest=${sq(previousReleaseDir)} ${sq(artifactPath)}/ ${sq(releaseDir)}/`,
        );
        await this.executor.rm(artifactPath).catch(() => {});
        return releaseDir;
      } catch {
        // rsync missing or failed (older minimal images) — fall back to
        // plain move below. We log nothing because either the move
        // succeeds (no user impact) or the move fails and the outer
        // deploy() reports it.
        await this.executor.rm(releaseDir).catch(() => {});
      }
    }

    await execReliable(
      this.executor,
      `deploy:${deploymentId}:promote-mv`,
      `mv ${sq(artifactPath)} ${sq(releaseDir)}`,
    );
    return releaseDir;
  }

  // ── File transfer ──────────────────────────────────────────────────────

  /**
   * Transfer files from a local path on the API server into the build/deploy dir.
   *
   * Delegates entirely to the executor - LocalExecutor does cp,
   * SshExecutor does tar+pipe. No branching here.
   */
  async transferFiles(
    localPath: string,
    remotePath: string,
    logger: BuildLogger,
  ): Promise<void> {
    // The executor packs the source into a single archive and uploads that one
    // file (ssh2 SFTP, or a cat stream over the OpenSSH ControlMaster), then
    // verifies + extracts it on the target. No rsync: it delta-syncs a tree
    // against an existing copy, which buys nothing for one fresh archive.
    await transferLocalDirectory(
      localPath,
      {
        kind: "executor",
        executor: this.executor,
        path: remotePath,
      },
      logger,
    );
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();

    // "local" = build on the API host, then transfer output to the target.
    // "server" (default) = build directly on the target via the executor.
    // When the executor is already local, both modes are equivalent.
    const buildLocally =
      config.buildStrategy === "local" &&
      !(this.executor instanceof LocalExecutor);

    const abort = new AbortController();
    this.activeBuilds.set(config.sessionId, abort);

    try {
      if (buildLocally) {
        return await this.buildLocally(config, log, abort);
      }
      return await this.buildOnTarget(config, log, abort);
    } finally {
      this.activeBuilds.delete(config.sessionId);
    }
  }

  /** Build on the API host, then transfer output to the target server. */
  private async buildLocally(
    config: BuildConfig,
    log: BuildLogger,
    abort: AbortController,
  ): Promise<BuildResult> {
    log.log("Build strategy: local (build on API host, transfer to server)\n");
    const remoteDir = this.buildDir(config.sessionId);

    const stackDef: StackDefinition | undefined = STACKS[config.stack as StackId];
    // Set by transferOutput when a Next.js standalone bundle is detected — the
    // build then dictates the start command (`node server.js`), overriding the
    // snapshot's `next start`. Surfaced on the BuildResult below.
    let standaloneStartCommand: string | undefined;

    let result: Awaited<ReturnType<typeof runLocalBuild>>;
    try {
      result = await runLocalBuild({
        config,
        logger: log,
        abort: abort.signal,
        preflight: async (cfg, plog, localExec) => {
          await this.ensureToolchain(localExec, cfg.stack, plog);
          plog.log("Checking runtime tools on target server...\n");
          await this.ensureToolchain(this.executor, cfg.stack, plog);
          if (this.systemManager) {
            plog.log("Ensuring rsync is installed on target server...\n");
            await this.systemManager.ensureComponents(["rsync"], (entry) => plog.callback(entry));
          }
        },
        transferOutput: async (buildDir) => {
          await this.executor.rm(remoteDir);
          await this.executor.mkdir(remoteDir);

          // Self-contained build output (detect-only): if this stack's build
          // emitted a wholesale-shippable bundle (e.g. Next's `output:'standalone'`),
          // ship it as-is — traced node_modules included — and skip the on-target
          // install. Absent → falls through to host mode.
          const selfContained = await prepareStackOutput(
            config.stack,
            resolveProjectDir(buildDir, config.rootDirectory),
          );
          if (selfContained) {
            log.log("Detected self-contained build output — shipping the bundle (no install on target).\n");
            await transferLocalDirectory(
              selfContained.bundleDir,
              { kind: "executor", executor: this.executor, path: remoteDir },
              log,
              { excludes: [] }, // ship everything, incl. traced node_modules
            );
            standaloneStartCommand = selfContained.startCommand;
            return;
          }

          // Default ("auto") mode - rsync over system `ssh` first, tar
          // through ssh2 only as fallback. See transferFiles above for
          // the full rationale (system ssh ≫ Node ssh2 on the wire).
          if (stackDef?.productionPaths?.length) {
            // Compiled stacks (Go, Rust, .NET, etc.) - transfer only production artifacts
            log.log(`Transferring production paths: ${stackDef.productionPaths.join(", ")}\n`);
            await transferLocalDirectory(
              buildDir,
              { kind: "executor", executor: this.executor, path: remoteDir },
              log,
              { includes: [...stackDef.productionPaths] },
            );
          } else {
            // Runtime stacks (JS/TS, Python, …): ship the tracked source PLUS
            // the build output, drop deps/caches. The build dir is a git clone,
            // so packing uses git-truth — which omits the (gitignored) build
            // output — hence `alsoInclude: [outputDirectory]` re-adds it there.
            // `excludes` covers the no-git fallback (local-path/upload sources),
            // where buildOutputTransferExcludes keeps the output by name.
            await transferLocalDirectory(
              buildDir,
              { kind: "executor", executor: this.executor, path: remoteDir },
              log,
              {
                excludes: buildOutputTransferExcludes(stackDef),
                alsoInclude: stackDef?.outputDirectory ? [stackDef.outputDirectory] : undefined,
              },
            );
          }

          // Install production dependencies on target if needed
          const installCmd = config.installCommand?.trim();
          if (installCmd) {
            // Ensure the package manager exists before install (corepack for pnpm/yarn).
            const pmEnsure = packageManagerEnsureCommand(config.packageManager);
            const fullInstall = pmEnsure ? `${pmEnsure} && ${installCmd}` : installCmd;
            log.log("Installing production dependencies on target...\n");
            const { code } = await this.executor.streamExec(
              `cd ${sq(remoteDir)} && ${fullInstall}`,
              log.callback,
            );
            if (code !== 0) {
              throw new Error("Failed to install production dependencies on target");
            }
            log.log("Production dependencies installed.\n");
          }
        },
      });
    } catch (err) {
      const msg = safeErrorMessage(err);
      log.log(`Failed to transfer local build output: ${msg}`, "error");
      return {
        sessionId: config.sessionId,
        status: "failed",
        imageRef: remoteDir,
        errorMessage: `Failed to transfer build output: ${msg}`,
      };
    }

    return {
      sessionId: config.sessionId,
      status: result.status,
      imageRef: remoteDir,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage,
      startCommand: standaloneStartCommand,
    };
  }

  /** Build directly on the target machine via the executor. */
  private async buildOnTarget(
    config: BuildConfig,
    log: BuildLogger,
    abort: AbortController,
  ): Promise<BuildResult> {
    log.log("Build strategy: server (build on target)\n");
    const dir = this.buildDir(config.sessionId);
    await this.executor.rm(dir);
    await this.executor.mkdir(dir);

    const buildEnv: BuildEnvironment = {
      projectDir: dir,
      exec: async (command, logCb) => {
        if (abort.signal.aborted) throw new BuildCancelledError();
        const effectiveCommand = this.executor instanceof LocalExecutor
          ? wrapLocalBuildCommand(command)
          : command;
        const { code, output } = await this.executor.streamExec(effectiveCommand, logCb);
        if (abort.signal.aborted) throw new BuildCancelledError();
        if (code !== 0) {
          const hint = detectBuildKillHint(output);
          throw new Error(
            `Command failed with exit code ${code}${hint ? ` - ${hint}` : ""}`,
          );
        }
      },
      preflight: async (cfg, plog) => {
        if (abort.signal.aborted) throw new BuildCancelledError();
        await this.ensureToolchain(this.executor, cfg.stack, plog);
        if (cfg.localPath) {
          await this.transferFiles(cfg.localPath, dir, plog);
        }
      },
      // Out-of-band secret write (SSH key + known_hosts) — goes through the
      // executor's file channel, never the streamed `exec`, so key bytes never
      // reach the build log. Works for both local and SSH executors.
      writeSecretFile: (p, content) => this.executor.writeFile(p, content),
    };

    const result = await runBuildPipeline(buildEnv, config, log);
    return {
      sessionId: config.sessionId,
      status: result.status,
      imageRef: dir,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage,
    };
  }

  /**
   * Check that the target executor has the required toolchain for a stack,
   * and install any missing or outdated tools.
   */
  private async ensureToolchain(
    executor: CommandExecutor,
    stack: string,
    plog: BuildLogger,
  ): Promise<void> {
    const toolcheck = await checkToolchainForStack(executor, stack);
    if (toolcheck.ready) return;

    const requiredTools = toolcheck.tools.filter((tool) => !tool.healthy);
    // Make the one-time nature explicit: this only installs on a fresh server;
    // subsequent deploys find the tools present and skip straight past prepare.
    plog.log("Installing build tools (one-time server setup)…\n");
    plog.log(`${requiredTools.map((tool) => tool.message).join("\n")}\n`);

    const results = await installTools(
      executor,
      requiredTools.map((tool) => tool.name),
      plog.callback,
      Object.fromEntries(
        requiredTools
          .filter((tool) => tool.requiredVersion)
          .map((tool) => [tool.name, tool.requiredVersion!]),
      ),
    );
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      throw new Error(
        `Failed to install required tools: ${failed.map((f) => `${f.tool} (${f.error})`).join(", ")}`,
      );
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    const abort = this.activeBuilds.get(sessionId);
    if (abort) {
      abort.abort();
      this.activeBuilds.delete(sessionId);
    }
    // Aborting only gates the API BETWEEN commands — the in-flight remote
    // command (git/npm/vite) keeps running on the target until killed. Kill every
    // process whose CWD is (under) this build's dir — SIGTERM, then SIGKILL the
    // survivors. Killing it closes the streamExec channel so the pipeline unwinds
    // to a cancelled result. Best-effort; a no-op for local builds / non-Linux
    // targets (nothing runs under this dir there).
    const dir = sq(this.buildDir(sessionId));
    const scan = (sig: string) =>
      `for p in /proc/[0-9]*; do c=$(readlink "$p/cwd" 2>/dev/null); case "$c" in ${dir}|${dir}/*) kill -${sig} "\${p##*/}" 2>/dev/null || true;; esac; done`;
    await this.executor.exec(`${scan("TERM")}; sleep 2; ${scan("KILL")}`).catch(() => {});
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig, _onLog?: LogCallback): Promise<DeploymentResult> {
    // Adopt mode: attach to an already-running, externally-supervised process
    // (e.g. the Openship control plane launched by `openship up`). We never
    // promote a build artifact or start a supervisor unit — that would bind a
    // second process to the port. We only health-probe and return a running
    // result so the routing/SSL pipeline can own this deployment. containerId is
    // set to the deploymentId (same convention as a real bare deploy) so the
    // route-registration containerId guard is satisfied.
    if (config.adopt) {
      const occupant = await probeListeningPort(this.executor, config.port);
      _onLog?.({
        timestamp: new Date().toISOString(),
        level: occupant ? "info" : "warn",
        message: occupant
          ? `[adopt] attached to process on port ${config.port}: ${occupant.command}\n`
          : `[adopt] no process is listening on port ${config.port} yet — routing will attach when it comes up\n`,
      });
      return {
        deploymentId: config.deploymentId,
        containerId: config.deploymentId,
        status: "running",
      };
    }

    const stagedDir = config.imageRef ?? this.projectDir(config.projectId);
    const workDir = config.imageRef
      ? await this.promoteBuildArtifact(
          stagedDir,
          config.deploymentId,
          config.previousDeploymentId,
        )
      : stagedDir;

    // Before the process starts, not after: the app may open a file under one of
    // these paths on boot, and it must already be the shared one.
    await this.linkPersistentPaths(workDir, config.projectId, config.volumes, _onLog);

    const sv = await this.supervisor();

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(config.envVars ?? {}).map(([k, v]) => [k, String(v)]),
      ),
      PORT: String(config.port),
      NODE_ENV: config.environment === "production" ? "production" : "development",
    };

    try {
      await sv.deploy({
        deploymentId: config.deploymentId,
        projectId: config.projectId,
        workDir,
        startCommand: config.startCommand || "npm start",
        port: config.port,
        env,
      });
    } catch (err) {
      if (workDir !== stagedDir) {
        await sv.destroy(config.deploymentId).catch(() => {});
        await this.executor.rm(workDir).catch(() => {});
      }
      throw err;
    }

    return {
      deploymentId: config.deploymentId,
      containerId: config.deploymentId,
      status: "running",
    };
  }

  async deployStatic(config: DeployConfig & { outputDirectory: string }): Promise<DeploymentResult> {
    const stagedDir = config.imageRef ?? this.projectDir(config.projectId);
    const workDir = config.imageRef
      ? await this.promoteBuildArtifact(
          stagedDir,
          config.deploymentId,
          config.previousDeploymentId,
        )
      : stagedDir;
    const staticRoot = resolveStaticOutputPath(workDir, config.outputDirectory);

    const abort = async (message: string): Promise<never> => {
      if (workDir !== stagedDir) {
        await this.executor.rm(workDir).catch(() => {});
      }
      throw new Error(message);
    };

    if (!(await this.executor.exists(staticRoot))) {
      return abort(missingOutputDirectoryMessage(config.outputDirectory));
    }

    // Present but EMPTY is unambiguously broken — no path under an empty root can
    // serve anything, so unlike a missing index.html (which is legitimate when the
    // site is routed only at a subpath) this needs no knowledge of the routes to
    // call. Catches the common "build wrote nothing" / "wrong output directory"
    // case at deploy time, where the error can still name the cause, instead of
    // deploying green and 404ing. Index presence is left to the route-aware
    // post-deploy audit, which is advisory by design.
    if (await this.isEmptyDir(staticRoot)) {
      return abort(
        `The output directory "${config.outputDirectory || "."}" is empty — the build produced ` +
          `no files to serve, so every request would 404. Check the build command and the ` +
          `Output Directory setting.`,
      );
    }

    return {
      deploymentId: config.deploymentId,
      containerId: workDir,
      status: "running",
    };
  }

  /**
   * Is this an existing directory with no entries? Any inconclusive answer (not a
   * directory, unreadable, exec failed) returns false — a probe that can't read
   * must never be the thing that fails a deploy.
   */
  private async isEmptyDir(path: string): Promise<boolean> {
    // Explicit tokens + forced exit 0, same discipline as probeStaticOutput: absence
    // is an ANSWER here, not a command failure. A plain file (legitimately its own
    // index) prints no DIR and is therefore never reported empty.
    const p = sq(path);
    const out = await this.executor
      .exec(`if [ -d ${p} ]; then echo DIR; ls -A ${p} 2>/dev/null | head -1; fi; true`)
      .catch(() => null);
    if (out === null) return false; // inconclusive → never fail the deploy
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length === 1 && lines[0] === "DIR";
  }

  async stop(containerId: string): Promise<void> {
    const sv = await this.supervisor();
    await sv.stop(containerId);
  }

  async start(containerId: string): Promise<void> {
    const sv = await this.supervisor();
    if (await sv.isRunning(containerId)) return;
    await sv.start(containerId);
  }

  async restart(containerId: string): Promise<void> {
    const sv = await this.supervisor();
    await sv.restart(containerId);
  }

  async destroy(containerId: string): Promise<void> {
    if (containerId.includes("/")) {
      await this.executor.rm(containerId);
      return;
    }

    const sv = await this.supervisor();
    await sv.destroy(containerId);
  }

  // ── Rollback primitives ──────────────────────────────────────────────
  //
  // Bare semantics:
  //   The release dir at workDir/releases/<deploymentId> IS the artifact.
  //   The supervisor unit is the activation. Rollback flips which
  //   release the supervisor unit serves by stop/start sequencing.
  //
  //   makeActive — stop `from`'s supervisor unit, then start `to`'s.
  //     The release dirs are stable on disk; we're just changing which
  //     unit is running. Matches the user's "mv path + reload" mental
  //     model — the path doesn't physically move, but the active one
  //     swaps via the supervisor.
  //   archive   — stop the supervisor unit. Release dir stays on disk
  //     (the actual rollback-restorable artifact).
  //   purge     — destroy the supervisor unit + rm -rf the release dir.

  async makeActive(input: RollbackInput): Promise<MakeActiveResult> {
    if (input.from?.containerId) {
      try {
        await this.stop(input.from.containerId);
      } catch {
        // already stopped / gone — ignore
      }
    }
    if (!input.to.containerId) {
      // No containerId means the supervisor unit was destroyed. The
      // release dir might still be on disk but without the unit we
      // can't restart it. Fail closed — the orchestrator will return
      // ARTIFACT_GONE upstream.
      throw new Error(
        `Cannot make deployment ${input.to.id} active: supervisor unit is gone. Artifact has been purged.`,
      );
    }
    await this.start(input.to.containerId);
    return { containerId: input.to.containerId };
  }

  async archive(deployment: DeploymentRef): Promise<void> {
    // Stop the supervisor unit. Release dir is intentionally NOT
    // removed — it's the artifact for future makeActive.
    if (!deployment.containerId) return;
    try {
      await this.stop(deployment.containerId);
    } catch {
      // already stopped — ignore
    }
  }

  async purge(deployment: DeploymentRef): Promise<void> {
    // Destroy supervisor unit (best-effort, idempotent) then drop the
    // release directory. The release dir is derived from deployment.id
    // via the same convention deploy() used (releaseDir helper).
    if (deployment.containerId) {
      try {
        await this.destroy(deployment.containerId);
      } catch {
        // already gone
      }
    }
    try {
      await this.executor.rm(this.releaseDir(deployment.id));
    } catch {
      // dir already removed — ignore
    }
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const sv = await this.supervisor();
    const running = await sv.isRunning(containerId);

    return {
      containerId,
      status: running ? "running" : "stopped",
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    const sv = await this.supervisor();
    return sv.getLogs(containerId, tail);
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const sv = await this.supervisor();
    return sv.streamLogs(containerId, onLog, opts);
  }

  /**
   * CPU / memory / disk-IO for the deployment's process.
   *
   * `containerId` is the DEPLOYMENT id here, not a docker container id — that's the
   * bare runtime's convention throughout (it's what the supervisor keys units and
   * PID files on).
   *
   * The supervisor owns the measurement because the identity differs: systemd has a
   * unit and a cgroup, nohup has a PID file. Both land on the same probe.
   */
  async getUsage(containerId: string): Promise<ResourceUsage> {
    const sv = await this.supervisor();
    return sv.getUsage(containerId);
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(_containerId: string): Promise<string | null> {
    // Bare processes run directly on the target host
    return "127.0.0.1";
  }
}
