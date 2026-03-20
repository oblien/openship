/**
 * Bare runtime — lightweight process management without Docker.
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
 * target machine's capabilities — no per-deploy branching.
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
import { checkToolchainForStack, installTools } from "../toolchain";
import type { RuntimeAdapter, RuntimeCapability } from "./types";
import { BuildLogger, runBuildPipeline, sq, type BuildEnvironment } from "./build-pipeline";
import { runLocalBuild } from "./local-build";
import { transferLocalDirectory } from "./transfer";
import type { ProcessSupervisor } from "./supervisor/types";
import { detectSupervisor } from "./supervisor/detect";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface BareRuntimeOptions {
  /** Base directory for project working directories (default: /opt/openship) */
  workDir?: string;
  /** Max time for build commands in ms (default: 10 min) */
  buildTimeout?: number;
  /**
   * Command executor — local or SSH.
   *
   * When provided, ALL commands and file operations are routed through
   * the executor. This is what makes bare runtime work on remote servers.
   * When omitted, a LocalExecutor is created automatically (same machine).
   */
  executor?: CommandExecutor;
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
  ]);

  private readonly workDir: string;
  private readonly buildTimeout: number;
  private executor: CommandExecutor;
  /** True if we created the executor ourselves (must dispose on cleanup) */
  private readonly ownsExecutor: boolean;
  /** Track active builds by sessionId for cancellation */
  private readonly activeBuilds = new Map<string, AbortController>();
  /** Process lifecycle delegate — resolved lazily on first deploy/stop/etc. */
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
  ): Promise<string> {
    const releaseDir = this.releaseDir(deploymentId);
    if (artifactPath === releaseDir) return releaseDir;

    await this.executor.mkdir(`${this.workDir}/releases`);
    await this.executor.rm(releaseDir);
    await this.executor.exec(`mv ${sq(artifactPath)} ${sq(releaseDir)}`);
    return releaseDir;
  }

  // ── File transfer ──────────────────────────────────────────────────────

  /**
   * Transfer files from a local path on the API server into the build/deploy dir.
   *
   * Delegates entirely to the executor — LocalExecutor does cp,
   * SshExecutor does tar+pipe. No branching here.
   */
  async transferFiles(
    localPath: string,
    remotePath: string,
    logger: BuildLogger,
  ): Promise<void> {
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
        },
        transferOutput: async (buildDir) => {
          await this.executor.rm(remoteDir);
          await this.executor.mkdir(remoteDir);
          await transferLocalDirectory(
            buildDir,
            {
              kind: "executor",
              executor: this.executor,
              path: remoteDir,
            },
            log,
            { excludes: [] },
          );
        },
      });
    } catch (err) {
      log.log(`Failed to transfer local build output: ${err instanceof Error ? err.message : String(err)}`, "error");
      return {
        sessionId: config.sessionId,
        status: "failed",
        imageRef: remoteDir,
      };
    }

    return {
      sessionId: config.sessionId,
      status: result.status,
      imageRef: remoteDir,
      durationMs: result.durationMs,
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
        const { code } = await this.executor.streamExec(effectiveCommand, logCb);
        if (abort.signal.aborted) throw new Error("Build cancelled");
        if (code !== 0) {
          throw new Error(`Command failed with exit code ${code}`);
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
      ? await this.promoteBuildArtifact(stagedDir, config.deploymentId)
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
    // Resource usage monitoring is supervisor-independent — systemd can use
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
