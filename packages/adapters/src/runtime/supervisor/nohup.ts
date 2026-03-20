/**
 * NohupSupervisor — process management via nohup + PID files.
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

import type { CommandExecutor, LogEntry, LogCallback } from "../../types";
import type { ProcessSupervisor, SupervisorDeployOpts } from "./types";
import { sq, parseLogLevel } from "../build-pipeline";
import { probeListeningPort } from "../port-conflict";
import { DeployError } from "@repo/core";

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
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private async writePid(id: string, pid: number): Promise<void> {
    await this.executor.mkdir(`${this.workDir}/.pids`);
    await this.executor.writeFile(this.pidFile(id), String(pid));
  }

  private async removePid(id: string): Promise<void> {
    await this.executor.rm(this.pidFile(id));
  }

  private async isAlive(pid: number): Promise<boolean> {
    try {
      await this.executor.exec(`kill -0 ${pid} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Artifact path tracking ───────────────────────────────────────────

  private async readArtifactPath(id: string): Promise<string | null> {
    try {
      const content = await this.executor.readFile(this.artifactFile(id));
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  private async writeArtifactPath(id: string, path: string): Promise<void> {
    await this.executor.mkdir(`${this.workDir}/.artifacts`);
    await this.executor.writeFile(this.artifactFile(id), path);
  }

  private async removeArtifactPath(id: string): Promise<void> {
    await this.executor.rm(this.artifactFile(id));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async deploy(opts: SupervisorDeployOpts): Promise<void> {
    await this.executor.mkdir(`${this.workDir}/.logs`);

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

    const pidStr = await this.executor.exec(spawnCmd);
    const pid = parseInt(pidStr.trim(), 10);

    if (isNaN(pid) || pid <= 0) {
      throw new Error("Deploy failed: could not capture process ID");
    }

    await this.writePid(opts.deploymentId, pid);
    await this.writeArtifactPath(opts.deploymentId, opts.workDir);

    // Brief liveness check — catch immediate crashes
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await this.isAlive(pid))) {
      let hint = "";
      try {
        const tail = await this.executor.exec(`tail -n 10 ${sq(logPath)}`);
        hint = tail.trim();
      } catch { /* log may not exist yet */ }

      // Detect EADDRINUSE — another process is holding the port
      if (hint.includes("EADDRINUSE")) {
        const occupant = await probeListeningPort(this.executor, opts.port);
        throw new DeployError(
          `Port ${opts.port} is already in use` +
            (occupant ? ` by ${occupant.command}` : "") +
            ". Stop the existing process before deploying.",
          "PORT_IN_USE",
          { port: opts.port, pid: occupant?.pid, command: occupant?.command },
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

    if (await this.isAlive(pid)) {
      // Kill entire process group (PGID = leader PID from setsid)
      await this.executor.exec(`kill -- -${pid} 2>/dev/null || kill ${pid} 2>/dev/null || true`);

      // Wait up to 10s for graceful shutdown
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await this.isAlive(pid))) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // SIGKILL if still alive
      if (await this.isAlive(pid)) {
        await this.executor.exec(`kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null || true`);
      }
    }
  }

  async start(_deploymentId: string): Promise<void> {
    throw new Error(
      "Nohup processes cannot be started after stopping. Trigger a new deployment.",
    );
  }

  async restart(deploymentId: string): Promise<void> {
    // Nohup can't restart — the service layer must re-deploy.
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
    } catch {
      return [];
    }
  }

  async streamLogs(
    deploymentId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const logPath = this.logFile(deploymentId);
    const tailN = opts?.tail ?? 100;

    let stopped = false;
    const promise = this.executor.streamExec(
      `tail -n ${tailN} -f ${sq(logPath)}`,
      (entry) => {
        if (!stopped) onLog({ ...entry, message: entry.message + "\r\n" });
      },
    );
    promise.catch(() => {});

    return () => {
      stopped = true;
      this.executor.exec(`pkill -f ${sq(`tail.*${logPath}`)} 2>/dev/null || true`).catch(() => {});
    };
  }
}
