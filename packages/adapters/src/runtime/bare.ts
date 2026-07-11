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
import { execReliable } from "../system/remote-journal";
import { STACKS, TRANSFER_EXCLUDES, safeErrorMessage, type StackId, type StackDefinition } from "@repo/core";
import { checkToolchainForStack, installTools } from "../toolchain";
import type {
  RuntimeAdapter,
  RuntimeCapability,
  DeploymentRef,
  RollbackInput,
  MakeActiveResult,
} from "./types";
import { BuildLogger, detectBuildKillHint, runBuildPipeline, sq, type BuildEnvironment } from "./build-pipeline";
import { runLocalBuild } from "./local-build";
import { transferLocalDirectory } from "./transfer";
import type { ProcessSupervisor } from "./supervisor/types";
import { detectSupervisor } from "./supervisor/detect";
import { posix as pathPosix } from "node:path";

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
    "containerIp",
    "rollback",
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

  private async promoteBuildArtifact(
    artifactPath: string,
    deploymentId: string,
    previousDeploymentId?: string,
  ): Promise<string> {
    const releaseDir = this.releaseDir(deploymentId);
    if (artifactPath === releaseDir) return releaseDir;

    await this.executor.mkdir(`${this.workDir}/releases`);
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
            // Runtime stacks (JS/TS, Python, etc.) - transfer everything except deps & caches
            const excludes = [
              ...TRANSFER_EXCLUDES,
              ...(stackDef?.cacheDirs ?? []),
            ];
            await transferLocalDirectory(
              buildDir,
              { kind: "executor", executor: this.executor, path: remoteDir },
              log,
              { excludes },
            );
          }

          // Install production dependencies on target if needed
          const installCmd = config.installCommand?.trim();
          if (installCmd) {
            log.log("Installing production dependencies on target...\n");
            const { code } = await this.executor.streamExec(
              `cd ${sq(remoteDir)} && ${installCmd}`,
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
        if (abort.signal.aborted) throw new Error("Build cancelled");
        const effectiveCommand = this.executor instanceof LocalExecutor
          ? wrapLocalBuildCommand(command)
          : command;
        const { code, output } = await this.executor.streamExec(effectiveCommand, logCb);
        if (abort.signal.aborted) throw new Error("Build cancelled");
        if (code !== 0) {
          const hint = detectBuildKillHint(output);
          throw new Error(
            `Command failed with exit code ${code}${hint ? ` - ${hint}` : ""}`,
          );
        }
      },
      preflight: async (cfg, plog) => {
        if (abort.signal.aborted) throw new Error("Build cancelled");
        await this.ensureToolchain(this.executor, cfg.stack, plog);
        if (cfg.localPath) {
          await this.transferFiles(cfg.localPath, dir, plog);
        }
      },
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
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig, _onLog?: LogCallback): Promise<DeploymentResult> {
    const stagedDir = config.imageRef ?? this.projectDir(config.projectId);
    const workDir = config.imageRef
      ? await this.promoteBuildArtifact(
          stagedDir,
          config.deploymentId,
          config.previousDeploymentId,
        )
      : stagedDir;
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
    const staticRoot = this.resolveStaticRoot(workDir, config.outputDirectory);

    if (!(await this.executor.exists(staticRoot))) {
      if (workDir !== stagedDir) {
        await this.executor.rm(workDir).catch(() => {});
      }
      throw new Error(`Static output directory does not exist: ${staticRoot}`);
    }

    return {
      deploymentId: config.deploymentId,
      containerId: workDir,
      status: "running",
    };
  }

  resolveStaticRoot(containerId: string, outputDirectory: string): string {
    if (!outputDirectory || outputDirectory === ".") {
      return containerId;
    }

    return outputDirectory.startsWith("/")
      ? outputDirectory
      : pathPosix.join(containerId, outputDirectory);
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

  async getUsage(_containerId: string): Promise<ResourceUsage> {
    // Resource usage monitoring is supervisor-independent - systemd can use
    // cgroup stats, nohup can use /proc. For now return zeros; the dashboard
    // already handles this gracefully.
    return { cpuPercent: 0, memoryMb: 0, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(_containerId: string): Promise<string | null> {
    // Bare processes run directly on the target host
    return "127.0.0.1";
  }
}
