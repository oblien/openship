/**
 * NohupSupervisor - process management via nohup + PID files.
 *
 * Fallback supervisor for targets without systemd (macOS, minimal containers).
 * Spawns processes via `nohup sh -lc '...' &`, tracks via PID files,
 * and uses `kill` for lifecycle management.
 *
 * Limitations vs systemd:
 *   - No automatic restart on crash
 *   - No reboot survival
 *   - No cgroups resource limits
 *   - Log rotation must be handled externally
 *
 * Good enough for: development, macOS desktop, CI environments.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { CommandExecutor, LogEntry, LogCallback, ResourceUsage, RuntimeLogStreamOptions } from "../../types";
import type { ProcessSupervisor, SupervisorDeployOpts } from "./types";
import { sampleBareUsage, ZERO_USAGE } from "./usage";
import { sq, parseLogLevel } from "../build-pipeline";
import { portOccupantDetails, probeListeningPort } from "../port-conflict";
import { execReliable } from "../../system/remote-journal";
import { DeployError } from "@repo/core";
import { ensureOwnedDir } from "../../system/elevated-executor";

export class NohupSupervisor implements ProcessSupervisor {
  readonly name = "nohup";

  constructor(
    private readonly executor: CommandExecutor,
    private readonly workDir: string,
  ) {}

  // ── Path helpers ─────────────────────────────────────────────────────

  private pidFile(id: string): string {
    return `${this.workDir}/.pids/${id}.pid`;
  }

  private logFile(id: string): string {
    return `${this.workDir}/.logs/${id}.log`;
  }

  private artifactFile(id: string): string {
    return `${this.workDir}/.artifacts/${id}.path`;
  }

  // ── PID helpers ──────────────────────────────────────────────────────

  private async readPid(id: string): Promise<number | null> {
    try {
      const content = await this.executor.readFile(this.pidFile(id));
      const pid = Number(content.trim());
      return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup");
      return null;
    }
  }

  private async writePid(id: string, pid: number): Promise<void> {
    await this.executor.writeFile(this.pidFile(id), String(pid));
  }

  private async removePid(id: string): Promise<void> {
    await this.executor.rm(this.pidFile(id));
  }

  private async isAlive(pid: number): Promise<boolean> {
    try {
      await this.executor.exec(`kill -0 ${pid} 2>/dev/null`);
      return true;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup");
      return false;
    }
  }

  // ── Artifact path tracking ───────────────────────────────────────────

  private async readArtifactPath(id: string): Promise<string | null> {
    try {
      const content = await this.executor.readFile(this.artifactFile(id));
      return content.trim() || null;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup");
      return null;
    }
  }

  private async writeArtifactPath(id: string, path: string): Promise<void> {
    await this.executor.writeFile(this.artifactFile(id), path);
  }

  private async removeArtifactPath(id: string): Promise<void> {
    await this.executor.rm(this.artifactFile(id));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async deploy(opts: SupervisorDeployOpts): Promise<void> {
    for (const directory of [".logs", ".pids", ".artifacts"]) {
      await ensureOwnedDir(this.executor, `${this.workDir}/${directory}`);
    }

    const envExports = Object.entries(opts.env)
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([k, v]) => `export ${k}=${sq(v)}`)
      .join("; ");

    const logPath = this.logFile(opts.deploymentId);
    const shellBody = envExports
      ? `${envExports}; cd ${opts.workDir} && ${opts.startCommand}`
      : `cd ${opts.workDir} && ${opts.startCommand}`;
    const runner = `nohup sh -lc ${sq(shellBody)} >> ${sq(logPath)} 2>&1 < /dev/null`;

    // setsid creates a new process group on Linux (survives SSH disconnect).
    // On macOS it doesn't exist, but backgrounding already detaches.
    const hasSetsid = await this.executor.exec("command -v setsid >/dev/null 2>&1 && echo y || echo n");
    const detach = hasSetsid.trim() === "y" ? `setsid ${runner}` : runner;
    const spawnCmd = `{ ${detach} & echo $!; }`;

    // Spawning the process is the activation COMMIT — journal it exactly-once
    // so a drop right after spawn (before we read the pid) can't make the retry
    // start a SECOND copy of the app. On re-drive the wrapper harvests the
    // recorded pid instead of re-spawning.
    const pidStr = await execReliable(
      this.executor,
      `deploy:${opts.deploymentId}:spawn`,
      spawnCmd,
    );
    const pid = parseInt(pidStr.trim(), 10);

    if (isNaN(pid) || pid <= 0) {
      throw new Error("Deploy failed: could not capture process ID");
    }

    await this.writePid(opts.deploymentId, pid);
    await this.writeArtifactPath(opts.deploymentId, opts.workDir);

    // Brief liveness check - catch immediate crashes
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await this.isAlive(pid))) {
      let hint = "";
      try {
        const tail = await this.executor.exec(`tail -n 10 ${sq(logPath)}`);
        hint = tail.trim();
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup"); /* log may not exist yet */ }

      // Detect EADDRINUSE - another process is holding the port
      if (hint.includes("EADDRINUSE")) {
        const occupant = await probeListeningPort(this.executor, opts.port);
        throw new DeployError(
          `Port ${opts.port} is already in use` +
            (occupant ? ` by ${occupant.command}` : "") +
            ". Stop the existing process before deploying.",
          "PORT_IN_USE",
          portOccupantDetails(opts.port, occupant),
        );
      }

      const msg = hint
        ? `Process exited immediately after spawn. Last output:\n${hint}`
        : "Process exited immediately after spawn (no output captured)";
      throw new Error(msg);
    }
  }

  async stop(deploymentId: string): Promise<void> {
    const pid = await this.readPid(deploymentId);
    if (!pid) return;

    // Without setsid (notably on macOS), the shell shares its caller's group.
    // Capture descendants before signalling it: killing only the shell leaves
    // npm/node children alive and still holding the application's port. Retain
    // those PIDs through reparenting, and include children forked during shutdown.
    const tracked = new Set([pid]);
    let ownsGroup = false;
    const readRunning = async () => {
      const output = await this.executor.exec("ps -e -o pid=,ppid=,pgid=,stat=");
      const rows = output.split("\n").flatMap(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4]! }] : [];
      });
      if (!rows.length) throw new Error("Could not inspect supervised process tree");
      ownsGroup ||= rows.some(row => row.pid === pid && row.group === pid);
      if (ownsGroup) for (const row of rows) if (row.group === pid) tracked.add(row.pid);
      let previousSize: number;
      do {
        previousSize = tracked.size;
        for (const row of rows) if (tracked.has(row.parent)) tracked.add(row.pid);
      } while (tracked.size !== previousSize);
      // Zombies have already released their sockets; only their parent can reap them.
      return rows.filter(row => tracked.has(row.pid) && !row.state.startsWith("Z"));
    };
    let running = await readRunning();
    const signal = async (name: "TERM" | "KILL") => {
      const targets = running.filter(row => !ownsGroup || row.group !== pid).map(row => row.pid);
      if (ownsGroup && running.some(row => row.group === pid)) targets.unshift(-pid);
      if (targets.length) await this.executor.exec(`kill -${name} -- ${targets.join(" ")} 2>/dev/null || true`);
    };
    const waitForExit = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (running.length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        running = await readRunning();
      }
    };

    await signal("TERM");
    await waitForExit(10_000);
    if (running.length) {
      await signal("KILL");
      await waitForExit(2_000);
    }
    if (running.length) throw new Error(`Supervised processes did not stop: ${running.map(row => row.pid).join(", ")}`);
    await this.removePid(deploymentId);
  }

  async start(_deploymentId: string): Promise<void> {
    throw new Error(
      "Nohup processes cannot be started after stopping. Trigger a new deployment.",
    );
  }

  async canStart(_deploymentId: string): Promise<boolean> {
    return false;
  }

  async restart(deploymentId: string): Promise<void> {
    // Nohup can't restart - the service layer must re-deploy.
    await this.stop(deploymentId);
  }

  async destroy(deploymentId: string): Promise<void> {
    await this.stop(deploymentId);
    await this.removePid(deploymentId);
    await this.executor.rm(this.logFile(deploymentId));

    const artifactPath = await this.readArtifactPath(deploymentId);
    if (artifactPath) {
      await this.executor.rm(artifactPath);
    }
    await this.removeArtifactPath(deploymentId);
  }

  async isRunning(deploymentId: string): Promise<boolean> {
    const pid = await this.readPid(deploymentId);
    if (!pid) return false;
    return this.isAlive(pid);
  }

  /**
   * Usage for the tracked process.
   *
   * No cgroup candidates: nohup does not create one (that's the documented
   * limitation above), so the probe uses /proc on Linux and `ps` on macOS. Both
   * measure the LEADER only — a start command that forks will under-report, which
   * is the same tradeoff as this supervisor's lack of restart and reboot handling.
   */
  async getUsage(deploymentId: string): Promise<ResourceUsage> {
    const pid = await this.readPid(deploymentId);
    if (!pid) return { ...ZERO_USAGE };
    return sampleBareUsage(this.executor, pid);
  }

  async getLogs(deploymentId: string, tail?: number): Promise<LogEntry[]> {
    const logPath = this.logFile(deploymentId);
    try {
      const lines = tail
        ? await this.executor.exec(`tail -n ${tail} ${sq(logPath)}`)
        : await this.executor.readFile(logPath);

      return lines
        .split("\n")
        .filter(Boolean)
        .map((line) => ({
          timestamp: new Date().toISOString(),
          message: line,
          level: parseLogLevel(line),
        }));
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup");
      return [];
    }
  }

  async streamLogs(
    deploymentId: string,
    onLog: LogCallback,
    opts?: RuntimeLogStreamOptions,
  ): Promise<() => void> {
    const logPath = this.logFile(deploymentId);
    const tailN = opts?.tail ?? 100;

    let stopped = false;
    // An adopted deployment has no supervisor log at all, and an empty viewer
    // gives the operator nothing to act on — say so once, up front.
    if (!(await this.executor.exists(logPath).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup"); return true; }))) {
      onLog({
        timestamp: new Date().toISOString(),
        message:
          "No supervisor log for this deployment — the process is supervised elsewhere " +
          "(container logs, or `openship logs` on the host). Streaming anyway in case it starts writing.\r\n",
        level: "info",
      });
    }
    // `--retry` + a pre-created file instead of a bare `tail -f`: a deployment
    // this supervisor never started (an ADOPT deployment — the process is
    // supervised by something else, e.g. `openship up`) has no log file here, and
    // `tail` wrote its own diagnostic to the stream, so the log viewer showed
    // "tail: cannot open '…/.logs/dep_x.log' for reading: No such file or
    // directory / tail: no files remaining" instead of anything about the app.
    // Touching the file makes the stream simply idle until something writes, and
    // 2>/dev/null keeps tail's chatter out of the user-visible log either way.
    const promise = this.executor.streamExec(
      `mkdir -p ${sq(`${this.workDir}/.logs`)} 2>/dev/null; ` +
        `touch ${sq(logPath)} 2>/dev/null; ` +
        `tail -n ${tailN} -F ${sq(logPath)} 2>/dev/null`,
      (entry) => {
        if (!stopped) onLog({ ...entry, message: entry.message + "\r\n" });
      },
    );
    void promise.then(
      (result) => {
        if (!stopped) opts?.onEnd?.(result.code === 0
          ? undefined
          : new Error(`Log reader exited with code ${result.code}`));
      },
      (error) => {
        observeCaughtError(error, "adapters/runtime/supervisor/nohup");
        if (!stopped) opts?.onEnd?.(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return () => {
      stopped = true;
      this.executor.exec(`pkill -f ${sq(`tail.*${logPath}`)} 2>/dev/null || true`).catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/runtime/supervisor/nohup");
      });
    };
  }
}
