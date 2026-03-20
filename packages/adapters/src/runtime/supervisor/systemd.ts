/**
 * SystemdSupervisor — process management via systemd unit files.
 *
 * Production-grade supervisor for Linux servers:
 *   - Writes a transient unit file per deployment
 *   - Uses systemctl for all lifecycle operations
 *   - Auto-restart on crash (Restart=on-failure)
 *   - Survives reboots (WantedBy=multi-user.target)
 *   - Logs via journalctl (structured, rotated automatically)
 *   - Language-agnostic — any start command works
 *
 * Unit naming: openship-{deploymentId}.service
 * Unit location: /etc/systemd/system/ (standard for admin-created units)
 */

import type { CommandExecutor, LogEntry, LogCallback } from "../../types";
import type { ProcessSupervisor, SupervisorDeployOpts } from "./types";
import { sq, parseLogLevel } from "../build-pipeline";
import { probeListeningPort } from "../port-conflict";
import { DeployError } from "@repo/core";

/** Prefix for all openship systemd units */
const UNIT_PREFIX = "openship";

export class SystemdSupervisor implements ProcessSupervisor {
  readonly name = "systemd";

  constructor(
    private readonly executor: CommandExecutor,
    private readonly workDir: string,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────

  private unitName(deploymentId: string): string {
    return `${UNIT_PREFIX}-${deploymentId}.service`;
  }

  private unitPath(deploymentId: string): string {
    return `/etc/systemd/system/${this.unitName(deploymentId)}`;
  }

  private artifactFile(id: string): string {
    return `${this.workDir}/.artifacts/${id}.path`;
  }

  private async writeArtifactPath(id: string, path: string): Promise<void> {
    await this.executor.mkdir(`${this.workDir}/.artifacts`);
    await this.executor.writeFile(this.artifactFile(id), path);
  }

  private async readArtifactPath(id: string): Promise<string | null> {
    try {
      const content = await this.executor.readFile(this.artifactFile(id));
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  private async removeArtifactPath(id: string): Promise<void> {
    await this.executor.rm(this.artifactFile(id));
  }

  /**
   * Build a systemd unit file contents string.
   *
   * Uses Type=exec so systemd tracks the actual process (not the shell wrapper).
   * Environment vars are set via Environment= directives (one per line)
   * which avoids any shell quoting issues.
   */
  private buildUnitFile(opts: SupervisorDeployOpts): string {
    const envLines = Object.entries(opts.env)
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([k, v]) => `Environment=${k}=${v}`)
      .join("\n");

    return `[Unit]
Description=Openship deployment ${opts.deploymentId}
After=network.target

[Service]
Type=exec
WorkingDirectory=${opts.workDir}
ExecStart=/bin/sh -lc ${sq(opts.startCommand)}
${envLines}
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${UNIT_PREFIX}-${opts.deploymentId}

[Install]
WantedBy=multi-user.target
`;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async deploy(opts: SupervisorDeployOpts): Promise<void> {
    const unitContent = this.buildUnitFile(opts);
    const unitPath = this.unitPath(opts.deploymentId);
    const unitName = this.unitName(opts.deploymentId);

    // Write the unit file
    await this.executor.writeFile(unitPath, unitContent);

    // Reload systemd to pick up the new unit, then enable + start
    await this.executor.exec("systemctl daemon-reload");
    await this.executor.exec(`systemctl enable --now ${sq(unitName)}`);

    // Track the artifact path for cleanup
    await this.writeArtifactPath(opts.deploymentId, opts.workDir);

    // Brief liveness check — catch immediate failures
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await this.isRunning(opts.deploymentId))) {
      // Read recent journal output for context
      let hint = "";
      try {
        const tail = await this.executor.exec(
          `journalctl -u ${sq(unitName)} -n 10 --no-pager 2>/dev/null`,
        );
        hint = tail.trim();
      } catch { /* journal may not be readable */ }

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
        ? `Process exited immediately after start. Last output:\n${hint}`
        : "Process exited immediately after start (no output captured)";
      throw new Error(msg);
    }
  }

  async stop(deploymentId: string): Promise<void> {
    const unitName = this.unitName(deploymentId);
    try {
      await this.executor.exec(`systemctl stop ${sq(unitName)} 2>/dev/null || true`);
    } catch {
      // Unit may not exist — that's OK
    }
  }

  async start(deploymentId: string): Promise<void> {
    const unitName = this.unitName(deploymentId);
    await this.executor.exec(`systemctl start ${sq(unitName)}`);
  }

  async restart(deploymentId: string): Promise<void> {
    const unitName = this.unitName(deploymentId);
    await this.executor.exec(`systemctl restart ${sq(unitName)}`);
  }

  async destroy(deploymentId: string): Promise<void> {
    const unitName = this.unitName(deploymentId);
    const unitPath = this.unitPath(deploymentId);

    // Stop and disable the service
    await this.executor.exec(
      `systemctl disable --now ${sq(unitName)} 2>/dev/null || true`,
    );

    // Remove the unit file
    await this.executor.rm(unitPath);

    // Reload so systemd forgets about it
    await this.executor.exec("systemctl daemon-reload");

    // Clean up artifact directory
    const artifactPath = await this.readArtifactPath(deploymentId);
    if (artifactPath) {
      await this.executor.rm(artifactPath);
    }
    await this.removeArtifactPath(deploymentId);
  }

  async isRunning(deploymentId: string): Promise<boolean> {
    const unitName = this.unitName(deploymentId);
    try {
      const result = await this.executor.exec(
        `systemctl is-active ${sq(unitName)} 2>/dev/null || true`,
      );
      return result.trim() === "active";
    } catch {
      return false;
    }
  }

  async getLogs(deploymentId: string, tail?: number): Promise<LogEntry[]> {
    const unitName = this.unitName(deploymentId);
    const tailArg = tail ? `-n ${tail}` : `-n 200`;
    try {
      const output = await this.executor.exec(
        `journalctl -u ${sq(unitName)} ${tailArg} --no-pager -o short-iso 2>/dev/null`,
      );

      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // journalctl short-iso format: "2025-01-01T00:00:00+0000 hostname unit[pid]: message"
          const match = line.match(/^(\S+)\s+\S+\s+\S+\s+(.*)/);
          return {
            timestamp: match?.[1] ?? new Date().toISOString(),
            message: match?.[2] ?? line,
            level: parseLogLevel(line),
          };
        });
    } catch {
      return [];
    }
  }

  async streamLogs(
    deploymentId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const unitName = this.unitName(deploymentId);
    const tailN = opts?.tail ?? 100;

    let stopped = false;
    const promise = this.executor.streamExec(
      `journalctl -u ${sq(unitName)} -n ${tailN} -f --no-pager -o short-iso 2>/dev/null`,
      (entry) => {
        if (stopped) return;
        // Strip journalctl prefix: "TIMESTAMP HOSTNAME UNIT[PID]: MESSAGE" → keep timestamp + message
        const match = entry.message.match(/^(\S+)\s+\S+\s+\S+\s+(.*)/);
        const cleaned = match
          ? { ...entry, timestamp: match[1], message: match[2] + "\r\n" }
          : { ...entry, message: entry.message + "\r\n" };
        onLog(cleaned);
      },
    );
    promise.catch(() => {});

    return () => {
      stopped = true;
      this.executor
        .exec(`pkill -f ${sq(`journalctl.*${unitName}`)} 2>/dev/null || true`)
        .catch(() => {});
    };
  }
}
