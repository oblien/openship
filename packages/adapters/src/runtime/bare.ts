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
 *   build()   → clone repo, install deps, build (via executor)
 *   deploy()  → spawn a long-running process, track via PID file
 *   stop()    → SIGTERM → SIGKILL fallback
 *   start()   → re-spawn the process
 *   destroy() → kill + remove working directory
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
import type { RuntimeAdapter, RuntimeCapability } from "./types";

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
    "containerIp",
  ]);

  private readonly workDir: string;
  private readonly buildTimeout: number;
  private executor: CommandExecutor;
  /** True if we created the executor ourselves (must dispose on cleanup) */
  private readonly ownsExecutor: boolean;

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

  private pidFile(processId: string): string {
    return `${this.workDir}/.pids/${processId}.pid`;
  }

  private logFile(processId: string): string {
    return `${this.workDir}/.logs/${processId}.log`;
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

  /** Check if a PID is alive on the target machine. */
  private async isAlive(pid: number): Promise<boolean> {
    try {
      await this.executor.exec(`kill -0 ${pid} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Command execution ──────────────────────────────────────────────

  private async runCommand(
    command: string,
    cwd: string,
    env: Record<string, string>,
    onLog?: LogCallback,
  ): Promise<void> {
    const logFn = (msg: string, level: LogEntry["level"] = "info") => {
      onLog?.({ timestamp: new Date().toISOString(), message: msg, level });
    };

    logFn(`$ ${command}`);

    // Build env prefix for the remote command
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");

    const fullCommand = envPrefix
      ? `cd ${JSON.stringify(cwd)} && ${envPrefix} ${command}`
      : `cd ${JSON.stringify(cwd)} && ${command}`;

    const { code } = await this.executor.streamExec(fullCommand, (entry) => {
      onLog?.(entry);
    });

    if (code !== 0) {
      throw new Error(`Command failed with exit code ${code}: ${command}`);
    }
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  async build(config: BuildConfig, onLog?: LogCallback): Promise<BuildResult> {
    const start = Date.now();
    const dir = this.projectDir(config.projectId);
    const logFn = (msg: string, level: LogEntry["level"] = "info") => {
      onLog?.({ timestamp: new Date().toISOString(), message: msg, level });
    };

    try {
      logFn("Preparing source code...");
      await this.executor.mkdir(dir);

      const hasGit = await this.executor.exists(`${dir}/.git`);

      if (hasGit) {
        await this.runCommand(
          `git fetch --all && git reset --hard origin/${config.branch}`,
          dir,
          config.envVars,
          onLog,
        );
      } else {
        await this.runCommand(
          `git clone --depth 1 --branch ${config.branch} ${config.repoUrl} .`,
          dir,
          config.envVars,
          onLog,
        );
      }

      if (config.commitSha) {
        await this.runCommand(
          `git checkout ${config.commitSha}`,
          dir,
          config.envVars,
          onLog,
        );
      }

      logFn("Installing dependencies...");
      await this.runCommand(config.installCommand, dir, config.envVars, onLog);

      logFn("Building...");
      await this.runCommand(config.buildCommand, dir, config.envVars, onLog);

      const durationMs = Date.now() - start;
      logFn(`Build completed in ${(durationMs / 1000).toFixed(1)}s`);

      return {
        sessionId: config.sessionId,
        status: "deploying",
        imageRef: dir,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      logFn(
        `Build failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return {
        sessionId: config.sessionId,
        status: "failed",
        durationMs,
      };
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    const pid = await this.readPid(`build-${sessionId}`);
    if (pid && (await this.isAlive(pid))) {
      await this.executor.exec(`kill ${pid} 2>/dev/null || true`);
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
  async deploy(config: DeployConfig): Promise<DeploymentResult> {
    const dir = this.projectDir(config.projectId);
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
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");

    // Spawn detached process: nohup + background, write PID to stdout
    const spawnCmd = [
      `cd ${JSON.stringify(dir)}`,
      `${envPrefix} nohup npm start >> ${JSON.stringify(logPath)} 2>&1 &`,
      `echo $!`,
    ].join(" && ");

    const pidStr = await this.executor.exec(spawnCmd);
    const pid = parseInt(pidStr.trim(), 10);

    if (!isNaN(pid) && pid > 0) {
      await this.writePid(config.deploymentId, pid);
    }

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
      // SIGTERM first
      await this.executor.exec(`kill ${pid} 2>/dev/null || true`);

      // Wait up to 10s for graceful shutdown
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await this.isAlive(pid))) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // SIGKILL if still alive
      if (await this.isAlive(pid)) {
        await this.executor.exec(`kill -9 ${pid} 2>/dev/null || true`);
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
    await this.stop(containerId);
    await this.removePid(containerId);
    await this.executor.rm(this.logFile(containerId));
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
        ? await this.executor.exec(`tail -n ${tail} ${JSON.stringify(logPath)}`)
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
