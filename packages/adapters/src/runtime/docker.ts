/**
 * Docker runtime — manages containers via the Docker Engine API (dockerode).
 *
 * Supports three connection modes:
 *   - Local socket (default, zero config)
 *   - Remote via SSH tunnel (ssh2 streamlocal forwarding to Docker socket)
 *   - Remote via TCP + mutual TLS
 *
 * This is ONLY the runtime. Routing (Nginx) and SSL (certbot) are separate
 * infrastructure providers — see `infra/`.
 *
 * Build strategy:
 *   Builds from a staged source context sent to the Docker daemon. If the
 *   repository already provides a Dockerfile, that becomes the source of
 *   truth. Otherwise Openship generates a minimal builder Dockerfile.
 *   Deploy creates a container from the resulting image.
 *
 * SECURITY MODEL:
 *   - SSH: uses the same configured credentials as the standard SSH executor
 *     (password, private key, or SSH agent).
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
import type { Feature, SystemLog } from "../system/types";

import type {
  RuntimeAdapter,
  RuntimeCapability,
  MultiServiceGroupHandle,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
} from "./types";
import { BuildLogger, parseLogLevel } from "./build-pipeline";
import { createDockerBuildContext } from "./docker-build-context";
import {
  type DockerConnectionOptions,
  type DockerTransport,
  resolveDockerTransport,
} from "./docker-transport";

// ─── Connection config ───────────────────────────────────────────────────────
export type { DockerConnectionOptions } from "./docker-transport";

interface DockerSystemManager {
  ensureFeature(feature: Feature, onLog?: (log: SystemLog) => void): Promise<void>;
}

// ─── Shared Docker helpers ───────────────────────────────────────────────────

const RESTART_POLICIES: Record<string, { Name: string; MaximumRetryCount: number }> = {
  always: { Name: "always", MaximumRetryCount: 0 },
  "on-failure": { Name: "on-failure", MaximumRetryCount: 5 },
  "unless-stopped": { Name: "unless-stopped", MaximumRetryCount: 0 },
  no: { Name: "no", MaximumRetryCount: 0 },
};

function resolveRestartPolicy(policy?: string) {
  return RESTART_POLICIES[policy ?? "always"] ?? RESTART_POLICIES.always;
}

/** Parse port specs ("8080:3000", "3000") into Docker ExposedPorts + PortBindings */
function parsePortBindings(portSpecs: string[]): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, { HostPort: string }[]>;
} {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};
  for (const spec of portSpecs) {
    const parts = spec.split(":");
    if (parts.length === 2) {
      const [hostPort, containerPort] = parts;
      exposedPorts[`${containerPort}/tcp`] = {};
      portBindings[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
    } else if (parts.length === 1) {
      exposedPorts[`${parts[0]}/tcp`] = {};
      portBindings[`${parts[0]}/tcp`] = [{ HostPort: "" }]; // random host port
    }
  }
  return { exposedPorts, portBindings };
}

/** Extract first host port and first container IP from an inspected container */
function extractNetworkInfo(data: { NetworkSettings: any }): {
  ip?: string;
  hostPort?: number;
} {
  let ip: string | undefined;
  for (const net of Object.values(data.NetworkSettings.Networks ?? {}) as any[]) {
    if (net.IPAddress) { ip = net.IPAddress; break; }
  }
  let hostPort: number | undefined;
  for (const bindings of Object.values(data.NetworkSettings.Ports ?? {}) as any[]) {
    if (bindings?.[0]?.HostPort) {
      hostPort = parseInt(bindings[0].HostPort, 10);
      break;
    }
  }
  return { ip, hostPort };
}

// ─── Docker runtime ──────────────────────────────────────────────────────────

export class DockerRuntime implements RuntimeAdapter {
  readonly name = "docker";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "deploy",
    "multiServiceDeploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "streamLogs",
    "usage",
    "containerIp",
  ]);

  /** Underlying dockerode instance — exposed for advanced usage */
  readonly docker: Dockerode;
  /** Connection config this runtime was created with */
  readonly connectionOptions?: DockerConnectionOptions;
  /** Resolved transport — single switch point for socket / ssh / tcp */
  readonly transport: DockerTransport;
  private readonly systemManager: DockerSystemManager | null;

  constructor(opts?: DockerConnectionOptions, systemManager?: DockerSystemManager | null) {
    this.connectionOptions = opts;
    this.transport = resolveDockerTransport(opts);
    this.docker = new Dockerode(this.transport.dockerodeOptions);
    this.systemManager = systemManager ?? null;
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
      await this.ensureDockerFeature();
      await this.transport.preflight();
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureDockerFeature(logger?: BuildLogger): Promise<void> {
    if (!this.systemManager) {
      return;
    }

    await this.systemManager.ensureFeature("deploy", (entry) => {
      logger?.log(entry.message, entry.level);
    });
  }

  /** Get Docker daemon info (version, platform, etc.) */
  async info(): Promise<Record<string, unknown>> {
    return this.docker.info();
  }

  // ── Image naming ────────────────────────────────────────────────────────

  /** Canonical image tag for a build session. */
  private imageTag(slug: string | undefined, sessionId: string): string {
    const name = slug ? `openship/${slug}` : `openship/build`;
    return `${name}:${sessionId}`;
  }

  /** Labels applied to both build images and deploy containers. */
  private labels(config: { deploymentId?: string; projectId: string; sessionId?: string }) {
    const l: Record<string, string> = {
      "openship.project": config.projectId,
    };
    if (config.deploymentId) l["openship.deployment"] = config.deploymentId;
    if (config.sessionId) l["openship.build"] = config.sessionId;
    return l;
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  private emitDockerStep(
    logger: BuildLogger,
    step: "clone" | "install" | "build",
    status: "running" | "completed" | "skipped",
    message: string,
  ): void {
    logger.step(step, status, message);
  }

  private handleBuildEvent(
    event: {
      stream?: string;
      error?: string;
      errorDetail?: { message?: string };
      status?: string;
      id?: string;
      progress?: string;
      aux?: unknown;
    },
    logger: BuildLogger,
  ): string | null {
    const errorMessage = event.errorDetail?.message ?? event.error;
    if (errorMessage) {
      logger.log(errorMessage, "error");
      return errorMessage;
    }

    if (event.stream) {
      const line = event.stream.trim();
      if (!line) return null;

      const marker = line.match(
        /^\[openship-build\]\s+step=(clone|install|build)\s+status=(running|completed|skipped)$/,
      );
      if (marker) {
        const [, step, status] = marker;
        this.emitDockerStep(
          logger,
          step as "clone" | "install" | "build",
          status as "running" | "completed" | "skipped",
          line,
        );

        // After the last step completes, Docker still needs to commit the
        // layer and run the runtime stage (COPY, etc.). Log so users know.
        if (status === "completed" && (step === "build" || step === "install")) {
          logger.log("Packaging image...");
        }

        return null;
      }

      if (this.isLowSignalDockerLine(line)) {
        return null;
      }

      logger.log(line, parseLogLevel(line));
      return this.extractBuildFailureHint(line);
    }

    if (event.status) {
      const parts = [event.id, event.status, event.progress]
        .filter((p): p is string => Boolean(p?.trim()))
        .map((p) => p.trim());
      if (parts.length) logger.log(parts.join(" "));
    }

    return null;
  }

  private static readonly DOCKER_BUILDER_NOISE: RegExp[] = [
    /^Step \d+\/\d+\s*:/i,       // Step 3/12 : RUN ...
    /^--->/i,                     // ---> abc123def
    /^Running in\s+[a-f0-9]{6,}$/i,
    /^Removing intermediate container\s+[a-f0-9]{6,}$/i,
    /^Successfully built\s+[a-f0-9]{6,}$/i,
    /^Successfully tagged\s+/i,
  ];

  private isLowSignalDockerLine(line: string): boolean {
    return DockerRuntime.DOCKER_BUILDER_NOISE.some((p) => p.test(line));
  }

  private extractBuildFailureHint(line: string): string | null {
    if (/returned a non-zero code:\s*\d+/i.test(line)) {
      return line;
    }

    if (/\/workspace\/package\.json/i.test(line) && /ENOENT/i.test(line)) {
      return "Docker build ran from /workspace but package.json was not found there. The configured rootDirectory is likely empty or incorrect.";
    }

    if (/failed to solve|executor failed running|error: build/i.test(line)) {
      return line;
    }

    return null;
  }

  private formatDockerConnectivityError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    if (/^Cannot reach Docker daemon:/i.test(message)) {
      return message;
    }

    return `Cannot reach Docker daemon: ${message}. ${this.transport.unreachableHint}`;
  }

  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();
    const startTime = Date.now();
    const tag = this.imageTag(config.slug, config.sessionId);

    try {
      log.log(`Build strategy: docker (${this.transport.description})\n`);

      // Ensure the host is provisioned for Docker, but avoid doing a second
      // SSH bridge handshake before the real build request. The build call
      // itself is the connectivity check and saves one full round-trip.
      try {
        await this.ensureDockerFeature(log);
      } catch (featureErr) {
        throw new Error(this.formatDockerConnectivityError(featureErr));
      }

      this.emitDockerStep(log, "clone", "running", "Preparing Docker build context...");

      const buildContext = await createDockerBuildContext(config, {
        requireRepositoryDockerfile: config.stack === "docker",
      });
      this.emitDockerStep(log, "clone", "completed", "Docker build context ready");

      if (buildContext.rootDirectory) {
        log.log(`Using Docker build root: ${buildContext.rootDirectory}`);
      }

      if (buildContext.usesRepositoryDockerfile) {
        this.emitDockerStep(
          log,
          "install",
          "skipped",
          "Repository Dockerfile owns dependency installation",
        );
        this.emitDockerStep(
          log,
          "build",
          "running",
          "Building image from repository Dockerfile...",
        );
      }

      if (!buildContext.usesRepositoryDockerfile && !config.installCommand) {
        this.emitDockerStep(log, "install", "skipped", "No install command configured");
      }
      if (!buildContext.usesRepositoryDockerfile && !config.buildCommand) {
        this.emitDockerStep(log, "build", "skipped", "No build command configured");
      }

      log.log(`Building image ${tag}...`);

      let stream: NodeJS.ReadableStream;
      try {
        stream = await this.docker.buildImage(
          { context: buildContext.contextDir, src: buildContext.contextEntries },
          {
            t: tag,
            dockerfile: buildContext.dockerfileName,
            labels: this.labels({ projectId: config.projectId, sessionId: config.sessionId }),
            buildargs: {
              ...config.envVars,
              NODE_ENV: "production",
            },
            forcerm: true,
          },
        );
      } finally {
        await buildContext.cleanup();
      }

      log.log("Connected to Docker daemon, streaming build output...");
      let fatalBuildError: string | null = null;

      // followProgress is dockerode's documented approach for build output
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : resolve()),
          (event: {
            stream?: string;
            error?: string;
            errorDetail?: { message?: string };
            status?: string;
            id?: string;
            progress?: string;
            aux?: unknown;
          }) => {
            fatalBuildError ??= this.handleBuildEvent(event, log);
          },
        );
      });

      if (fatalBuildError) {
        throw new Error(fatalBuildError);
      }

      try {
        await this.docker.getImage(tag).inspect();
      } catch {
        throw new Error(`Docker build finished but the image ${tag} was not created`);
      }

      log.step("build", "completed", `Image ${tag} built successfully`);
      const durationMs = Date.now() - startTime;
      return { sessionId: config.sessionId, status: "deploying", imageRef: tag, durationMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.step("build", "failed", `Docker build failed: ${msg}`);
      return { sessionId: config.sessionId, status: "failed", durationMs: Date.now() - startTime, errorMessage: `Docker build failed: ${msg}` };
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    // Attempt to find and kill the build container by label
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`openship.build=${sessionId}`] },
    });
    for (const c of containers) {
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
      } catch { /* already removed */ }
    }
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult> {
    const log = onLog ?? (() => {});
    const imageRef = config.imageRef;
    if (!imageRef) {
      throw new Error("Docker deploy requires an imageRef (built image tag)");
    }

    const containerName = `openship-${config.slug || config.projectId}-${config.deploymentId}`;

    // Environment variables
    const env = [
      `PORT=${config.port}`,
      `NODE_ENV=${config.environment === "production" ? "production" : "development"}`,
      ...Object.entries(config.envVars).map(([k, v]) => `${k}=${v}`),
    ];

    // Start command — if provided, split into Cmd array
    const cmd = config.startCommand
      ? ["sh", "-c", config.startCommand]
      : undefined;

    const restartPolicy = resolveRestartPolicy(config.restartPolicy);

    log({
      timestamp: new Date().toISOString(),
      message: `Creating container ${containerName} from ${imageRef}...\n`,
      level: "info",
    });

    const container = await this.docker.createContainer({
      name: containerName,
      Image: imageRef,
      Cmd: cmd,
      Env: env,
      Labels: this.labels({
        deploymentId: config.deploymentId,
        projectId: config.projectId,
      }),
      ExposedPorts: { [`${config.port}/tcp`]: {} },
      HostConfig: {
        RestartPolicy: restartPolicy,
        Memory: config.resources.memoryMb * 1024 * 1024,
        CpuShares: Math.round(config.resources.cpuCores * 1024),
        // Expose port for Nginx upstream routing or direct access
        PortBindings: {
          [`${config.port}/tcp`]: [{ HostPort: "" }], // random host port
        },
      },
    });

    await container.start();

    log({
      timestamp: new Date().toISOString(),
      message: `Container ${container.id.slice(0, 12)} started.\n`,
      level: "info",
    });

    return {
      deploymentId: config.deploymentId,
      containerId: container.id,
      status: "running",
    };
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

    const { ip, hostPort } = extractNetworkInfo(data);

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

    // Docker multiplexed streams prepend 8-byte frame headers per line.
    // Strip them before parsing text.
    const stripHeaders = (buf: Buffer): string => {
      const lines: string[] = [];
      let offset = 0;
      while (offset < buf.length) {
        if (offset + 8 <= buf.length &&
            (buf[offset] === 1 || buf[offset] === 2) &&
            buf[offset + 1] === 0 && buf[offset + 2] === 0 && buf[offset + 3] === 0) {
          const size = buf.readUInt32BE(offset + 4);
          lines.push(buf.subarray(offset + 8, offset + 8 + size).toString("utf-8"));
          offset += 8 + size;
        } else {
          // No header — treat rest as raw text
          lines.push(buf.subarray(offset).toString("utf-8"));
          break;
        }
      }
      return lines.join("");
    };

    const raw = stripHeaders(buffer);

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const spaceIdx = line.indexOf(" ");
        const timestamp = spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString();
        const message = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;

        return { timestamp, message, level: parseLogLevel(message) };
      });
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const container = this.docker.getContainer(containerId);
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      follow: true,
      tail: opts?.tail ?? 100,
    }) as unknown as NodeJS.ReadableStream;

    let destroyed = false;



    // Docker multiplexed streams prepend an 8-byte frame header per chunk
    // when both stdout and stderr are attached. Strip it before parsing.
    const stripDockerHeader = (chunk: Buffer): Buffer => {
      // Header format: [stream_type(1), 0, 0, 0, size(4 big-endian)]
      // stream_type: 1 = stdout, 2 = stderr
      if (chunk.length >= 8 && (chunk[0] === 1 || chunk[0] === 2) &&
          chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0) {
        return chunk.subarray(8);
      }
      return chunk;
    };

    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      if (destroyed) return;
      buffer += stripDockerHeader(chunk).toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const spaceIdx = line.indexOf(" ");
        const timestamp = spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString();
        const message = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;
        onLog({ timestamp, message, level: parseLogLevel(message) });
      }
    });

    stream.on("end", () => {
      if (buffer && !destroyed) {
        onLog({ timestamp: new Date().toISOString(), message: buffer, level: parseLogLevel(buffer) });
        buffer = "";
      }
    });

    return () => {
      if (!destroyed) {
        destroyed = true;
        // Destroy the follow stream to stop Docker from sending more data
        if ("destroy" in stream && typeof (stream as any).destroy === "function") {
          (stream as any).destroy();
        }
      }
    };
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

  // ── Compose / multi-service ────────────────────────────────────────────

  /**
   * Ensure a project-level Docker network exists.
   * All services in a compose project share this network and can
   * reach each other by service name as hostname.
   */
  async ensureNetwork(slug: string): Promise<string> {
    const networkName = `openship-${slug}`;
    const networks = await this.docker.listNetworks({
      filters: { name: [networkName] },
    });

    // listNetworks does substring matching, verify exact name
    const existing = networks.find((n) => n.Name === networkName);
    if (existing) return existing.Id;

    const network = await this.docker.createNetwork({
      Name: networkName,
      Driver: "bridge",
      Labels: { "openship.network": slug },
    });
    return network.id;
  }

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
  }): Promise<MultiServiceGroupHandle> {
    void config.deploymentId;
    void config.projectId;
    return { id: await this.ensureNetwork(config.slug) };
  }

  /** Remove a project network (best-effort). */
  async removeNetwork(slug: string): Promise<void> {
    const networkName = `openship-${slug}`;
    try {
      const network = this.docker.getNetwork(networkName);
      await network.remove();
    } catch {
      // Already removed or doesn't exist — fine
    }
  }

  /**
   * Deploy a single service container on a project network.
   * Unlike `deploy()` which binds to a random host port,
   * service containers join the project network with their service name as hostname.
   * External port bindings are only created for services that explicitly expose ports.
   */
  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    const log = onLog ?? (() => {});
    const containerName = `openship-${config.slug}-${config.serviceName}`;

    // Stop and remove any existing container with the same name
    try {
      const existing = this.docker.getContainer(containerName);
      await existing.remove({ force: true });
    } catch {
      // Does not exist — fine
    }

    // Environment variables
    const env = Object.entries(config.environment).map(([k, v]) => `${k}=${v}`);

    // Command
    const cmd = config.command
      ? ["sh", "-c", config.command]
      : undefined;

    // Port bindings
    const { exposedPorts, portBindings } = parsePortBindings(config.ports);

    // Parse volumes: pass through directly — Docker handles named volumes and bind mounts
    const binds = config.volumes.length > 0 ? config.volumes : undefined;

    const restartPolicy = resolveRestartPolicy(config.restart);

    log({
      timestamp: new Date().toISOString(),
      message: `Creating service container ${containerName} from ${config.image}...\n`,
      level: "info",
    });

    // Pull image if not local
    if (!config.image.startsWith("openship/")) {
      try {
        log({
          timestamp: new Date().toISOString(),
          message: `Pulling image ${config.image}...\n`,
          level: "info",
        });
        const stream = await this.docker.pull(config.image);
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (err) {
        log({
          timestamp: new Date().toISOString(),
          message: `Failed to pull ${config.image}: ${err}\n`,
          level: "error",
        });
        throw err;
      }
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Cmd: cmd,
      Env: env,
      Hostname: config.serviceName,
      Labels: {
        ...this.labels({
          deploymentId: config.deploymentId,
          projectId: config.projectId,
        }),
        "openship.service": config.serviceName,
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        RestartPolicy: restartPolicy,
        ...(config.resources?.memoryMb && {
          Memory: config.resources.memoryMb * 1024 * 1024,
        }),
        ...(config.resources?.cpuCores && {
          CpuShares: Math.round(config.resources.cpuCores * 1024),
        }),
        PortBindings: portBindings,
        Binds: binds,
        NetworkMode: group.id,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [group.id]: {
            Aliases: [config.serviceName],
          },
        },
      },
    });

    try {
      await container.start();
    } catch (startErr) {
      // Clean up the created container so it doesn't become orphaned
      try { await container.remove({ force: true }); } catch { /* best effort */ }
      throw startErr;
    }

    // Get container IP on the project network
    const data = await container.inspect();
    const { ip, hostPort } = extractNetworkInfo(data);

    log({
      timestamp: new Date().toISOString(),
      message: `Service ${config.serviceName} started (${container.id.slice(0, 12)})${ip ? ` at ${ip}` : ""}.\n`,
      level: "info",
    });

    return {
      containerId: container.id,
      status: "running",
      ip,
      hostPort,
    };
  }

  async deployService(
    config: MultiServiceDeployConfig & { networkId: string },
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    return this.deployServiceWorkload({ id: config.networkId }, config, onLog);
  }
}
