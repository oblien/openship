/**
 * Docker runtime — manages containers via the Docker Engine API (dockerode).
 *
 * Supports three connection modes:
 *   - Local socket (default, zero config)
 *   - Remote via SSH (key auth, built-in ssh2)
 *   - Remote via TCP + mutual TLS
 *
 * This is ONLY the runtime. Routing (Traefik) and SSL (ACME) are separate
 * infrastructure providers — see `infra/`.
 *
 * SECURITY MODEL:
 *   - SSH: key-based auth ONLY. Password auth is deliberately not supported.
 *   - SSH keys should be encrypted at rest and decrypted in memory only.
 *   - Host fingerprints can be pinned via `hostVerifier` (TOFU or strict).
 *   - TCP: mutual TLS (client cert + CA) — no plaintext TCP.
 */

import Dockerode from "dockerode";

import type {
  BuildConfig,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
} from "../types";

import type { RuntimeAdapter, RuntimeCapability } from "./types";

// ─── Connection config ───────────────────────────────────────────────────────

export interface DockerConnectionOptions {
  /** Transport type */
  transport: "socket" | "ssh" | "tcp";

  /** Host for SSH / TCP transports */
  host?: string;
  /** Port (SSH default 22, TCP default 2376) */
  port?: number;

  /** SSH username (key auth only — no password) */
  username?: string;
  /**
   * Decrypted SSH private key (PEM string).
   * Should be the in-memory decrypted key, never read from disk.
   */
  privateKey?: string;
  /** Passphrase for the SSH private key (if the key itself is encrypted) */
  privateKeyPassphrase?: string;
  /** SSH agent socket path (alternative to privateKey) */
  sshAgent?: string;
  /**
   * Custom host key verifier for SSH connections.
   * Return `true` to accept, `false` to reject.
   */
  hostVerifier?: (hostKey: Buffer) => boolean;

  /** TLS CA certificate (for TCP transport) */
  ca?: string | Buffer;
  /** TLS client certificate (for TCP transport) */
  cert?: string | Buffer;
  /** TLS client key (for TCP transport) */
  key?: string | Buffer;

  /** Docker API request timeout in ms (default: 30 000) */
  timeout?: number;
}

/** Build a Dockerode options object from our connection config */
function toDockerodeOptions(opts?: DockerConnectionOptions): Dockerode.DockerOptions {
  if (!opts || opts.transport === "socket") {
    return { socketPath: "/var/run/docker.sock" };
  }

  if (opts.transport === "ssh") {
    if (!opts.privateKey && !opts.sshAgent) {
      throw new Error(
        "SSH transport requires either a privateKey or sshAgent. " +
          "Password authentication is not supported for security reasons.",
      );
    }

    return {
      protocol: "ssh",
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.username,
      sshOptions: {
        privateKey: opts.privateKey,
        passphrase: opts.privateKeyPassphrase,
        agent: opts.sshAgent,
        tryKeyboard: false,
        hostVerifier: opts.hostVerifier
          ? (key: Buffer) => opts.hostVerifier!(key)
          : undefined,
      },
      timeout: opts.timeout ?? 30_000,
    };
  }

  // TCP + mutual TLS
  if (!opts.ca || !opts.cert || !opts.key) {
    throw new Error(
      "TCP transport requires ca, cert, and key for mutual TLS. " +
        "Plaintext TCP connections are not supported for security reasons.",
    );
  }

  return {
    protocol: "https",
    host: opts.host,
    port: opts.port ?? 2376,
    ca: opts.ca as string | undefined,
    cert: opts.cert as string | undefined,
    key: opts.key as string | undefined,
    timeout: opts.timeout ?? 30_000,
  };
}

// ─── Docker runtime ──────────────────────────────────────────────────────────

export class DockerRuntime implements RuntimeAdapter {
  readonly name = "docker";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "deploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "usage",
    "containerIp",
  ]);

  /** Underlying dockerode instance — exposed for advanced usage */
  readonly docker: Dockerode;
  /** Connection config this runtime was created with */
  readonly connectionOptions?: DockerConnectionOptions;

  constructor(opts?: DockerConnectionOptions) {
    this.connectionOptions = opts;
    this.docker = new Dockerode(toDockerodeOptions(opts));
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // dockerode handles connection cleanup internally via ssh2 / modem
  }

  // ─── Health check ──────────────────────────────────────────────────

  /** Ping the Docker daemon — useful for connection testing */
  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Get Docker daemon info (version, platform, etc.) */
  async info(): Promise<Record<string, unknown>> {
    return this.docker.info();
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  async build(config: BuildConfig, onLog?: LogCallback): Promise<BuildResult> {
    // TODO: Build implementation using:
    //   1. Clone repo into temp dir or use `docker.buildImage()` with tar context
    //   2. Stream build output via onLog callback
    //   3. Tag the resulting image
    onLog?.({ timestamp: new Date().toISOString(), message: "Build queued", level: "info" });
    return { sessionId: config.sessionId, status: "queued" };
  }

  async cancelBuild(sessionId: string): Promise<void> {
    // TODO: Kill the build container by session label
    void sessionId;
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig): Promise<DeploymentResult> {
    // TODO: Create and start a container using:
    //   this.docker.createContainer({ Image, Env, HostConfig, Labels, ... })
    //   container.start()
    return { deploymentId: config.deploymentId, status: "queued" };
  }

  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop();
  }

  async start(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async restart(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.restart();
  }

  async destroy(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force: true });
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();

    const statusMap: Record<string, ContainerInfo["status"]> = {
      running: "running",
      exited: "stopped",
      paused: "stopped",
      restarting: "running",
      dead: "failed",
      created: "stopped",
    };

    const startedAt = data.State.StartedAt;
    const uptimeSeconds = startedAt && data.State.Running
      ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
      : undefined;

    let hostPort: number | undefined;
    for (const bindings of Object.values(data.NetworkSettings.Ports ?? {})) {
      if (bindings?.[0]?.HostPort) {
        hostPort = parseInt(bindings[0].HostPort, 10);
        break;
      }
    }

    let ip: string | undefined;
    for (const net of Object.values(data.NetworkSettings.Networks ?? {})) {
      if (net.IPAddress) {
        ip = net.IPAddress;
        break;
      }
    }

    return {
      containerId,
      status: statusMap[data.State.Status] ?? "stopped",
      ip,
      hostPort,
      uptimeSeconds: uptimeSeconds && uptimeSeconds > 0 ? uptimeSeconds : undefined,
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    const container = this.docker.getContainer(containerId);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: tail ?? 200,
    });

    const raw = buffer.toString("utf-8");

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const spaceIdx = line.indexOf(" ");
        const timestamp = spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString();
        const message = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;

        const level = /\b(error|fatal|panic)\b/i.test(message)
          ? "error" as const
          : /\bwarn(ing)?\b/i.test(message)
            ? "warn" as const
            : "info" as const;

        return { timestamp, message, level };
      });
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    const container = this.docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numCpus = stats.cpu_stats.online_cpus || 1;
    const cpuPercent =
      systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    const memoryMb = (stats.memory_stats.usage ?? 0) / (1024 * 1024);

    let networkRxBytes = 0;
    let networkTxBytes = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        networkRxBytes += iface.rx_bytes ?? 0;
        networkTxBytes += iface.tx_bytes ?? 0;
      }
    }

    let diskBytes = 0;
    if (stats.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        diskBytes += entry.value ?? 0;
      }
    }
    const diskMb = diskBytes / (1024 * 1024);

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryMb: Math.round(memoryMb * 100) / 100,
      diskMb: Math.round(diskMb * 100) / 100,
      networkRxBytes,
      networkTxBytes,
    };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(containerId: string): Promise<string | null> {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();

    for (const net of Object.values(data.NetworkSettings.Networks ?? {})) {
      if (net.IPAddress) return net.IPAddress;
    }
    return null;
  }
}
