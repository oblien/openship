/**
 * Bare runtime — lightweight process management without Docker.
 *
 * Runs applications directly on the target server via shell commands.
 * All operations go through a CommandExecutor, so the bare runtime
 * works identically on the local machine and on remote servers via SSH.
 *
 * Good for:
 *   - Development environments
 *   - Simple single-app servers where Docker is overkill
 *   - Edge deployments (low-resource machines)
 *   - Desktop app (local development)
 *
 * Process lifecycle:
 *   build()   → clone repo, install deps, build (via executor or locally)
 *   deploy()  → spawn a long-running process, track via PID file
 *   stop()    → SIGTERM → SIGKILL fallback
 *   start()   → re-spawn the process
 *   destroy() → kill + remove working directory
 *
 * buildStrategy support:
 *   "server" → clone + build on the target machine (via executor)
 *   "local"  → clone + build on the API host, then transfer output to target
 *
 * No containers, no images, no Docker dependency at all.
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

import { LocalExecutor } from "../system/executor";
import { checkToolchainForStack, installTools } from "../toolchain";
import type { RuntimeAdapter, RuntimeCapability } from "./types";
import { BuildLogger, runBuildPipeline, sq, type BuildEnvironment } from "./build-pipeline";
import { runLocalBuild } from "./local-build";
import { transferLocalDirectory } from "./transfer";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface BareRuntimeOptions {
  /** Base directory for project working directories (default: /tmp/openship) */
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

const DEFAULT_WORK_DIR = "/tmp/openship";
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

  private pidFile(processId: string): string {
    return `${this.workDir}/.pids/${processId}.pid`;
  }

  private logFile(processId: string): string {
    return `${this.workDir}/.logs/${processId}.log`;
  }

  private artifactFile(processId: string): string {
    return `${this.workDir}/.artifacts/${processId}.path`;
  }

  // ─── PID management (via executor) ───────────────────────────────────

  private async readPid(processId: string): Promise<number | null> {
    try {
      const content = await this.executor.readFile(this.pidFile(processId));
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private async writePid(processId: string, pid: number): Promise<void> {
    await this.executor.mkdir(`${this.workDir}/.pids`);
    await this.executor.writeFile(this.pidFile(processId), String(pid));
  }

  private async removePid(processId: string): Promise<void> {
    await this.executor.rm(this.pidFile(processId));
  }

  private async readArtifactPath(processId: string): Promise<string | null> {
    try {
      const content = await this.executor.readFile(this.artifactFile(processId));
      const path = content.trim();
      return path || null;
    } catch {
      return null;
    }
  }

  private async writeArtifactPath(processId: string, artifactPath: string): Promise<void> {
    await this.executor.mkdir(`${this.workDir}/.artifacts`);
    await this.executor.writeFile(this.artifactFile(processId), artifactPath);
  }

  private async removeArtifactPath(processId: string): Promise<void> {
    await this.executor.rm(this.artifactFile(processId));
  }

  /** Check if a PID is alive on the target machine. */
  private async isAlive(pid: number): Promise<boolean> {
    try {
      await this.executor.exec(`kill -0 ${pid} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
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
    const remoteDir = this.projectDir(config.projectId);

    const result = await runLocalBuild({
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

    return {
      sessionId: config.sessionId,
      status: result.status,
      imageRef: result.status === "deploying" ? remoteDir : undefined,
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
        const { code } = await this.executor.streamExec(command, logCb);
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
      imageRef: result.status === "deploying" ? dir : undefined,
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

  /**
   * Deploy by spawning a detached background process on the target server.
   *
   * Uses `nohup` + `&` to background the process, redirects output to
   * a log file, and stores the PID. Works identically via local shell
   * or SSH — no node:child_process spawn() needed.
   */
  async deploy(config: DeployConfig, _onLog?: LogCallback): Promise<DeploymentResult> {
    const dir = config.imageRef ?? this.projectDir(config.projectId);
    const logPath = this.logFile(config.deploymentId);

    // Ensure log directory exists
    await this.executor.mkdir(`${this.workDir}/.logs`);

    // Build env string
    const envEntries = {
      ...config.envVars,
      PORT: String(config.port),
      NODE_ENV: config.environment === "production" ? "production" : "development",
    };
    const envPrefix = Object.entries(envEntries)
      .map(([k, v]) => `${k}=${sq(v)}`)
      .join(" ");

    const startCommand = config.startCommand || "npm start";

    // Spawn detached process in its own process group via setsid.
    // This ensures `kill -- -PGID` can clean up the entire tree.
    const spawnCmd = [
      `cd ${sq(dir)}`,
      `setsid ${envPrefix} nohup ${startCommand} >> ${sq(logPath)} 2>&1 &`,
      `echo $!`,
    ].join(" && ");

    const pidStr = await this.executor.exec(spawnCmd);
    const pid = parseInt(pidStr.trim(), 10);

    if (!isNaN(pid) && pid > 0) {
      await this.writePid(config.deploymentId, pid);
    }
    await this.writeArtifactPath(config.deploymentId, dir);

    return {
      deploymentId: config.deploymentId,
      containerId: config.deploymentId,
      status: "running",
    };
  }

  async stop(containerId: string): Promise<void> {
    const pid = await this.readPid(containerId);
    if (!pid) return;

    if (await this.isAlive(pid)) {
      // Kill the entire process group so child processes don't become orphans.
      // PGID equals the leader PID when spawned with setsid.
      await this.executor.exec(`kill -- -${pid} 2>/dev/null || kill ${pid} 2>/dev/null || true`);

      // Wait up to 10s for graceful shutdown
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await this.isAlive(pid))) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // SIGKILL the whole group if still alive
      if (await this.isAlive(pid)) {
        await this.executor.exec(`kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null || true`);
      }
    }
  }

  async start(containerId: string): Promise<void> {
    const pid = await this.readPid(containerId);
    if (pid && (await this.isAlive(pid))) return;

    throw new Error(
      "BareRuntime.start() requires a redeploy. Use restart() for running " +
        "processes or trigger a new deployment.",
    );
  }

  async restart(containerId: string): Promise<void> {
    await this.stop(containerId);
    // The service layer is responsible for calling deploy() again
  }

  async destroy(containerId: string): Promise<void> {
    if (containerId.includes("/")) {
      await this.executor.rm(containerId);
      return;
    }

    await this.stop(containerId);
    await this.removePid(containerId);
    await this.executor.rm(this.logFile(containerId));

    const artifactPath = await this.readArtifactPath(containerId);
    if (artifactPath) {
      await this.executor.rm(artifactPath);
    }
    await this.removeArtifactPath(containerId);
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const pid = await this.readPid(containerId);
    const running = pid !== null && (await this.isAlive(pid));

    return {
      containerId,
      status: running ? "running" : "stopped",
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    const logPath = this.logFile(containerId);

    try {
      // Use `tail` command instead of reading entire file — efficient for
      // large log files and works the same over SSH.
      const lines = tail
        ? await this.executor.exec(`tail -n ${tail} ${sq(logPath)}`)
        : await this.executor.readFile(logPath);

      return lines
        .split("\n")
        .filter(Boolean)
        .map((line) => ({
          timestamp: new Date().toISOString(),
          message: line,
          level: /\b(error|fatal|panic)\b/i.test(line)
            ? ("error" as const)
            : /\bwarn(ing)?\b/i.test(line)
              ? ("warn" as const)
              : ("info" as const),
        }));
    } catch {
      return [];
    }
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const logPath = this.logFile(containerId);
    const tailN = opts?.tail ?? 100;

    // Use streamExec with tail -f for real-time streaming
    let stopped = false;
    const promise = this.executor.streamExec(
      `tail -n ${tailN} -f ${sq(logPath)}`,
      (entry) => {
        if (!stopped) onLog(entry);
      },
    );

    // The stream resolves when tail exits (which normally won't happen
    // until the cleanup function kills it). Swallow errors from kill.
    promise.catch(() => {});

    return () => {
      stopped = true;
      // Kill the tail process watching this specific log file
      this.executor.exec(`pkill -f ${sq(`tail.*${logPath}`)} 2>/dev/null || true`).catch(() => {});
    };
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    // Try to get basic stats from /proc on Linux
    try {
      const pid = await this.readPid(containerId);
      if (!pid || !(await this.isAlive(pid))) {
        return { cpuPercent: 0, memoryMb: 0, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 };
      }

      // RSS from /proc (Linux only — gracefully fails elsewhere)
      const statm = await this.executor.exec(
        `cat /proc/${pid}/statm 2>/dev/null || echo "0 0"`,
      );
      const rssPages = parseInt(statm.split(" ")[1] ?? "0", 10);
      const memoryMb = (rssPages * 4096) / (1024 * 1024);

      return {
        cpuPercent: 0,
        memoryMb: Math.round(memoryMb * 100) / 100,
        diskMb: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
      };
    } catch {
      return { cpuPercent: 0, memoryMb: 0, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 };
    }
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(_containerId: string): Promise<string | null> {
    // Bare processes run directly on the target host
    return "127.0.0.1";
  }
}
