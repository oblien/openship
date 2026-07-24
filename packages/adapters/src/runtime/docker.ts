/**
 * Docker runtime - manages containers via the Docker Engine API (dockerode).
 *
 * Supports three connection modes:
 *   - Local socket (default, zero config)
 *   - Remote via SSH tunnel (ssh2 streamlocal forwarding to Docker socket)
 *   - Remote via TCP + mutual TLS
 *
 * This is ONLY the runtime. Routing (Nginx) and SSL (certbot) are separate
 * infrastructure providers - see `infra/`.
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
 *   - TCP: mutual TLS (client cert + CA) - no plaintext TCP.
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
  ContainerStatus,
  ResourceUsage,
  ShellOptions,
  ShellSession,
  ProvisionLock,
} from "../types";
import type { PortProbeExecutor } from "../system/port-listen";
import { PassThrough, Writable } from "node:stream";

/**
 * Detect "not found" errors from the Docker SDK (dockerode). The daemon
 * returns HTTP 404 for missing containers/images/volumes/networks. Used to make
 * destroy / removeImage idempotent across partial-cleanup retries, and to
 * distinguish ABSENT (drift / idempotent success) from UNREACHABLE. Shared
 * implementation lives in system/errors so the reconcile/cleanup paths key off
 * the same rule.
 */
const isDockerNotFoundError = isRuntimeNotFoundError;

/** Clamp a terminal window dimension to a sane min/max with default. */
function clampShellWindow(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.isFinite(value) ? Number(value) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
import type { Feature, SystemLog } from "../system/types";
import { isRuntimeNotFoundError } from "../system/errors";

import type {
  RuntimeAdapter,
  RuntimeCapability,
  MultiServiceGroupHandle,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  DeploymentRef,
  RollbackInput,
  MakeActiveResult,
  DockerContainerSummary,
  DockerContainerDetail,
  DockerMount,
  DockerPortBinding,
  DockerVolumeInfo,
  DockerNetworkInfo,
} from "./types";
import { BuildLogger, parseLogLevel, sq, assembleGitClone } from "./build-pipeline";
import { githubTarballUrl, downloadTarballOnRemote } from "./source-tarball";
import { scopeVolumeBinds, isHostPathSource } from "./volume-namespace";
import { createDockerBuildContext, prepareSourceTree, resolveServiceDockerfile } from "./docker-build-context";
import { resolveDockerfileCandidates } from "./docker-paths";
import { generateDockerfile } from "./docker-build-plan";
import { transferLocalDirectory } from "./transfer";
import { safeErrorMessage, type ComposeAdvanced, type ComposeHealthcheck } from "@repo/core";
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

const DOCKER_BUILD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function resolveRestartPolicy(policy?: string) {
  return RESTART_POLICIES[policy ?? "always"] ?? RESTART_POLICIES.always;
}

// ── Docker discovery normalizers (label-agnostic inspection) ─────────────────

/** dockerode list/inspect Mount → normalized DockerMount. Both shapes share the
 *  Type/Name/Source/Destination/RW fields this reads. */
function normalizeDockerMount(m: {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}): DockerMount {
  return {
    type: m.Type ?? "volume",
    ...(m.Name ? { name: m.Name } : {}),
    ...(m.Source ? { source: m.Source } : {}),
    destination: m.Destination ?? "",
    rw: m.RW !== false,
  };
}

/** Coerce dockerode Cmd/Entrypoint (string | string[] | null) → string[] | undefined. */
function toStringArray(v: string | string[] | null | undefined): string[] | undefined {
  if (v == null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.length > 0 ? arr : undefined;
}

/** Normalized port list from a container inspect: published ports (with host
 *  bindings) from NetworkSettings.Ports, plus exposed-only ports from
 *  Config.ExposedPorts that were never published. */
function normalizeInspectPorts(data: Dockerode.ContainerInspectInfo): DockerPortBinding[] {
  const out: DockerPortBinding[] = [];
  const seen = new Set<string>();
  const parseKey = (key: string): { port: number; proto: string } | null => {
    const [portStr, proto] = key.split("/");
    const port = Number(portStr);
    return Number.isFinite(port) ? { port, proto: proto || "tcp" } : null;
  };

  const nsPorts = (data.NetworkSettings?.Ports ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  for (const [key, bindings] of Object.entries(nsPorts)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    seen.add(key);
    if (bindings && bindings.length > 0) {
      for (const b of bindings) {
        out.push({
          privatePort: parsed.port,
          ...(b.HostPort ? { publicPort: Number(b.HostPort) } : {}),
          type: parsed.proto,
          ...(b.HostIp ? { ip: b.HostIp } : {}),
        });
      }
    } else {
      out.push({ privatePort: parsed.port, type: parsed.proto });
    }
  }

  // NetworkSettings.Ports is only populated while the container RUNS; a stopped
  // container reports its published ports in HostConfig.PortBindings instead.
  // Read that as a fallback so a stopped service's port mapping isn't lost.
  const hostBindings = (data.HostConfig?.PortBindings ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  for (const [key, bindings] of Object.entries(hostBindings)) {
    if (seen.has(key)) continue;
    const parsed = parseKey(key);
    if (!parsed) continue;
    seen.add(key);
    if (bindings && bindings.length > 0) {
      for (const b of bindings) {
        out.push({
          privatePort: parsed.port,
          ...(b.HostPort ? { publicPort: Number(b.HostPort) } : {}),
          type: parsed.proto,
          ...(b.HostIp ? { ip: b.HostIp } : {}),
        });
      }
    } else {
      out.push({ privatePort: parsed.port, type: parsed.proto });
    }
  }

  const exposed = (data.Config?.ExposedPorts ?? {}) as Record<string, object>;
  for (const key of Object.keys(exposed)) {
    if (seen.has(key)) continue;
    const parsed = parseKey(key);
    if (parsed) out.push({ privatePort: parsed.port, type: parsed.proto });
  }
  return out;
}

/** Parse port specs ("8080:3000", "3000", "127.0.0.1:8080:80") into Docker
 *  ExposedPorts + PortBindings */
function parsePortBindings(portSpecs: string[]): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, { HostIp?: string; HostPort: string }[]>;
} {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostIp?: string; HostPort: string }[]> = {};
  for (const spec of portSpecs) {
    // A protocol suffix ("/udp", "/sctp") applies to the container port and sits
    // at the very end of the spec. Strip it first, then split host:container.
    // Anything other than udp/sctp (including omitted) is tcp, matching Docker.
    const slashIdx = spec.lastIndexOf("/");
    const rawProto = slashIdx >= 0 ? spec.slice(slashIdx + 1).toLowerCase() : "";
    const protocol = rawProto === "udp" || rawProto === "sctp" ? rawProto : "tcp";
    const mapping = slashIdx >= 0 ? spec.slice(0, slashIdx) : spec;

    const parts = mapping.split(":");
    if (parts.length === 1) {
      // containerPort only → Docker assigns a random host port
      const key = `${parts[0]}/${protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: "" }];
    } else {
      // [hostIp:]hostPort:containerPort. Parse from the RIGHT so both the
      // 2-part (hostPort:containerPort) and 3-part IP-scoped form
      // ("127.0.0.1:8080:80" — a loopback-only publish, which the dashboard
      // editor emits) work; anything before hostPort is the host IP.
      const containerPort = parts[parts.length - 1]!;
      const hostPort = parts[parts.length - 2]!;
      const hostIp = parts.length > 2 ? parts.slice(0, -2).join(":") : undefined;
      const key = `${containerPort}/${protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [hostIp ? { HostIp: hostIp, HostPort: hostPort } : { HostPort: hostPort }];
    }
  }
  return { exposedPorts, portBindings };
}

const DURATION_UNITS_NS: Record<string, number> = {
  ns: 1,
  us: 1_000,
  "µs": 1_000,
  ms: 1_000_000,
  s: 1_000_000_000,
  m: 60_000_000_000,
  h: 3_600_000_000_000,
};

/**
 * Parse a compose/Go duration ("30s", "1m30s", "500ms") to nanoseconds — the
 * unit Docker's Engine API expects for Healthcheck timings. A bare number is
 * treated as seconds (lenient; compose long-form usually carries units, but
 * bare ints appear in the wild). Returns undefined when nothing parses, so the
 * caller omits the field and Docker keeps its default.
 */
function parseDurationNs(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1_000_000_000);
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    total += parseFloat(m[1]!) * DURATION_UNITS_NS[m[2]!]!;
  }
  return matched ? Math.round(total) : undefined;
}

/**
 * Convert a parsed compose healthcheck into a Docker Engine Healthcheck object.
 * `test` string → `["CMD-SHELL", cmd]`; `test` array → `["CMD", ...argv]`;
 * `disable` → `["NONE"]` (turns off an image's baked-in check). Returns
 * undefined when there's nothing to configure so the image default stands.
 */
function toDockerHealthcheck(hc?: ComposeHealthcheck):
  | { Test: string[]; Interval?: number; Timeout?: number; Retries?: number; StartPeriod?: number }
  | undefined {
  if (!hc) return undefined;
  if (hc.disable) return { Test: ["NONE"] };

  let Test: string[] | undefined;
  if (typeof hc.test === "string" && hc.test.trim()) {
    Test = ["CMD-SHELL", hc.test];
  } else if (Array.isArray(hc.test) && hc.test.length > 0) {
    Test = ["CMD", ...hc.test];
  }
  if (!Test) return undefined;

  const Interval = parseDurationNs(hc.interval);
  const Timeout = parseDurationNs(hc.timeout);
  const StartPeriod = parseDurationNs(hc.startPeriod);
  return {
    Test,
    ...(Interval !== undefined && { Interval }),
    ...(Timeout !== undefined && { Timeout }),
    ...(typeof hc.retries === "number" && { Retries: hc.retries }),
    ...(StartPeriod !== undefined && { StartPeriod }),
  };
}

/**
 * Detect whether a buffer chunk starts with Docker's 8-byte multiplexed
 * stream header (stream_type | 0 | 0 | 0 | size_be32).
 */
function hasDockerFrameHeader(buf: Buffer, offset = 0): boolean {
  return (
    buf.length >= offset + 8 &&
    (buf[offset] === 1 || buf[offset] === 2) &&
    buf[offset + 1] === 0 &&
    buf[offset + 2] === 0 &&
    buf[offset + 3] === 0
  );
}

/** Strip Docker multiplexed frame headers from a complete log buffer. */
function stripDockerHeaders(buf: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (hasDockerFrameHeader(buf, offset)) {
      const size = buf.readUInt32BE(offset + 4);
      lines.push(buf.subarray(offset + 8, offset + 8 + size).toString("utf-8"));
      offset += 8 + size;
    } else {
      lines.push(buf.subarray(offset).toString("utf-8"));
      break;
    }
  }
  return lines.join("");
}

/** Strip a single Docker frame header from one streaming chunk. */
function stripDockerChunkHeader(chunk: Buffer): Buffer {
  return hasDockerFrameHeader(chunk) ? chunk.subarray(8) : chunk;
}

/** Parse a Docker timestamp-prefixed log line into timestamp + message. */
function parseTimestampedLine(line: string): { timestamp: string; message: string } {
  const spaceIdx = line.indexOf(" ");
  return {
    timestamp: spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString(),
    message: spaceIdx > 0 ? line.slice(spaceIdx + 1) : line,
  };
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
    "rollback",
    "serviceShell",
    "projectContainerSweep",
    "deploymentContainerQuery",
  ]);

  /** Docker honors every extended compose key we currently support. */
  readonly unsupportedComposeKeys: ReadonlySet<keyof ComposeAdvanced> = new Set();

  private _docker!: Dockerode;
  /** Underlying dockerode instance - exposed for advanced usage */
  get docker(): Dockerode {
    return this._docker;
  }
  /** Connection config this runtime was created with */
  readonly connectionOptions?: DockerConnectionOptions;
  /** Resolved transport - single switch point for socket / ssh / tcp */
  readonly transport: DockerTransport;
  private readonly systemManager: DockerSystemManager | null;
  private readonly provisionLock?: ProvisionLock;

  private constructor(
    opts?: DockerConnectionOptions,
    systemManager?: DockerSystemManager | null,
    provisionLock?: ProvisionLock,
  ) {
    this.connectionOptions = opts;
    this.transport = resolveDockerTransport(opts);
    this.systemManager = systemManager ?? null;
    this.provisionLock = provisionLock;
  }

  /**
   * Build a runtime and stand up its transport. Async because the SSH
   * transport binds a loopback bridge whose port is only known after listen();
   * socket/TCP transports resolve their options synchronously.
   */
  static async create(
    opts?: DockerConnectionOptions,
    systemManager?: DockerSystemManager | null,
    provisionLock?: ProvisionLock,
  ): Promise<DockerRuntime> {
    const runtime = new DockerRuntime(opts, systemManager, provisionLock);
    runtime._docker = new Dockerode(await runtime.transport.establish());
    return runtime;
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // Tear down the SSH transport's loopback bridge (no-op for socket/TCP).
    await this.transport.close();
  }

  // ─── Health check ──────────────────────────────────────────────────

  /** Ping the Docker daemon - useful for connection testing */
  async ping(): Promise<boolean> {
    try {
      await this.assertReachable();
      return true;
    } catch (err) {
      // Collapsed to a boolean for liveness callers — but LOG the detailed
      // reason so it isn't lost. Paths that must show the user WHY it failed
      // should call assertReachable() and surface the thrown message instead.
      console.warn(`[docker] daemon unreachable: ${safeErrorMessage(err)}`);
      return false;
    }
  }

  /**
   * Assert the Docker daemon is reachable, RETHROWING the transport's detailed
   * diagnostic instead of collapsing it to false. For the SSH transport,
   * `preflight()` (verifyDockerSshBridge) builds a rich message — socket path,
   * streamlocal/permission hints, and remote diagnostics — which `ping()`
   * otherwise swallows. Use on user-facing paths (e.g. the migration scan) so
   * the real cause reaches the user instead of a generic "not reachable".
   */
  async assertReachable(): Promise<void> {
    await this.ensureDockerFeature();
    await this.transport.preflight();
    await this.docker.ping();
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

  /**
   * Sum the byte size of a directory tree. Best-effort - used only for a
   * human-readable "X MB context streamed" log line. Returns 0 if the
   * walk hits an error rather than failing the build.
   */
  private async estimateContextSize(dir: string): Promise<number> {
    const { stat, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            const s = await stat(full);
            total += s.size;
          } catch { /* ignore */ }
        }
      }
    }
    return total;
  }

  private emitDockerStep(
    logger: BuildLogger,
    step: "clone" | "install" | "build",
    status: "running" | "completed" | "skipped",
    message: string,
  ): void {
    // Mirror the step event to the terminal so users can follow the
    // phases in the build log too - otherwise the terminal stays blank
    // between text logs while the stepper bar quietly advances.
    const label = status === "running" ? "→" : status === "completed" ? "✓" : "↷";
    logger.log(`[${step}] ${label} ${message}`);
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

        // After install completes inside the RUN, Docker still needs to
        // commit layers, run the runtime stage (COPY, etc.), and tag the
        // image. Tell the user we're past the slow part - the rest is
        // fast and not progress-streamed.
        if (status === "completed" && step === "install") {
          logger.log("Finalizing image (layer commit + tag)...");
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

  // Only the truly-redundant lines get filtered. We KEEP "Step N/M : ..."
  // because that's the user's best progress signal during a long build -
  // it shows which Dockerfile instruction is currently executing.
  //
  // Removed (= now passes through to terminal):
  //   - "Step N/M : ..."  → high-signal, shows progress
  //   - "Successfully built / tagged" → confirms success
  //
  // Still filtered (= noise):
  //   - "---> hash"       → opaque layer hash, no signal for users
  //   - "Running in ..."  → intermediate container id, no signal
  //   - "Removing intermediate container ..." → cleanup chatter
  private static readonly DOCKER_BUILDER_NOISE: RegExp[] = [
    /^--->/i,                     // ---> abc123def
    /^Running in\s+[a-f0-9]{6,}$/i,
    /^Removing intermediate container\s+[a-f0-9]{6,}$/i,
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
    const message = safeErrorMessage(error);

    if (/^Cannot reach Docker daemon:/i.test(message)) {
      return message;
    }

    return `Cannot reach Docker daemon: ${message}. ${this.transport.unreachableHint}`;
  }

  /**
   * SSH transport build path. Bypasses dockerode's HTTP-over-SSH upload
   * (which is ~1-2 MB/s and silent) in favor of two well-trodden pieces:
   *
   *   1. `transferLocalDirectory(...)` - defaults to rsync over the
   *      SYSTEM `ssh` binary (NOT the Node `ssh2` library), with native
   *      `--progress` output streamed straight from rsync. ~10-30 MB/s
   *      typical. Lands the context at `/tmp/openship-build-<sessionId>`
   *      on remote. Falls back to tar through the ssh2 channel only if
   *      rsync isn't installed on either side.
   *
   *   2. `executor.streamExec("docker build ...")` - runs native docker
   *      CLI on the remote. Its raw stdout/stderr streams back unfiltered
   *      so the user sees real "Step N/M : ...", layer hashes, install
   *      output, etc. Same logs you'd see SSHing in and running it by hand.
   *
   * Container lifecycle (deploy, stop, logs, etc.) still uses dockerode -
   * only the slow build upload moves to this path.
   */
  /**
   * Ship a prepared context dir to the remote host (rsync via system ssh with
   * native --progress; tar/ssh2 fallback). Reused by both the single-image SSH
   * build and the batch build (which transfers the shared context ONCE).
   */
  private async transferBuildContext(
    contextDir: string,
    remoteContextDir: string,
    log: BuildLogger,
  ): Promise<void> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("SSH build path requires an executor on connectionOptions");

    log.log(`Streaming build context to ${remoteContextDir}...`);
    // Wipe stale dir from a previous failed deploy, if any. -rf is safe - the
    // path is namespaced and only ever holds the context we just transferred.
    await executor.exec(`rm -rf ${sq(remoteContextDir)} && mkdir -p ${sq(remoteContextDir)}`);
    // `contextDir` is ALREADY the final build context (prepareSourceTree applied
    // git-truth / cloned the tracked set and stripped `.git`). Transfer it
    // VERBATIM — pass `excludes: []` so the transfer doesn't re-apply the
    // name-based default and delete tracked source (e.g. an `app/.../build`
    // route) that the prepare step deliberately kept.
    await transferLocalDirectory(
      contextDir,
      { kind: "executor", executor, path: remoteContextDir },
      log,
      { excludes: [] },
    );
  }

  /**
   * Run native `docker build` on the remote host against an already-transferred
   * context dir. One image; `dockerfileName` selects which Dockerfile in the
   * shared tree to use (so N services can build from one transferred context).
   */
  private async buildImageOnRemote(
    config: BuildConfig,
    remoteContextDir: string,
    dockerfileName: string,
    tag: string,
    log: BuildLogger,
  ): Promise<void> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("SSH build path requires an executor on connectionOptions");

    // Compose the docker build command. Quoting matters - buildargs and labels
    // can contain `=` and spaces.
    const buildArgs = Object.entries({
      ...config.envVars,
      NODE_ENV: "production",
    })
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `--build-arg ${sq(`${k}=${v}`)}`)
      .join(" ");
    const labelArgs = Object.entries(
      this.labels({ projectId: config.projectId, sessionId: config.sessionId }),
    )
      .map(([k, v]) => `--label ${sq(`${k}=${v}`)}`)
      .join(" ");
    const dockerfileFlag =
      dockerfileName && dockerfileName !== "Dockerfile" ? ` -f ${sq(dockerfileName)}` : "";

    // `cd` into the context dir FIRST so docker resolves `-f` and the context
    // `.` from the same place (BuildKit otherwise resolves `-f` against the SSH
    // user's home, not the context).
    // --progress=plain: over a non-TTY SSH pipe BuildKit's compact auto-progress
    // prints terse "#N 0.xx" lines and DROPS the failed step's actual stdout/stderr
    // (an OOM-killed `bun install`, a tsup error, …), so a failed build surfaced only
    // as a bare "exited with code 1". Plain progress streams every line through.
    const buildCmd =
      `cd ${sq(remoteContextDir)} && ` +
      `docker build --progress=plain -t ${sq(tag)}${dockerfileFlag} ` +
      `${labelArgs} ${buildArgs} --force-rm .`;

    log.log(`Running on remote: ${buildCmd}`);
    log.log("─── docker build output ───");
    this.emitDockerStep(log, "install", "running", "Running install inside container (docker build)");

    const { code } = await executor.streamExec(buildCmd, (entry) => {
      // Pass docker's real output straight through.
      log.log(entry.message, parseLogLevel(entry.message));
    });

    log.log("─── end docker build output ───");
    if (code !== 0) throw new Error(`docker build exited with code ${code}`);
    this.emitDockerStep(log, "install", "completed", "Image build finished");
  }

  /**
   * Clone the repo directly ON the remote host into `remoteContextDir` — the
   * clone-on-server alternative to transferBuildContext (which clones on the
   * orchestrator and rsyncs the tree). Runs `git clone` in a remote host shell,
   * mirroring the bare runtime (build-pipeline.ts): the credential-helper relay
   * (`config.gitCredentialHelperPath` — plain URL, nothing persisted) when set,
   * else `injectGitToken(...)`. Strips `.git` so it never ships into the image.
   */
  private async cloneSourceOnRemote(
    config: BuildConfig,
    remoteContextDir: string,
    log: BuildLogger,
  ): Promise<void> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("Clone-on-server requires an SSH executor on connectionOptions");

    const useHelper = !!config.gitCredentialHelperPath;

    // Prefer a direct GitHub tarball download on the server (no git, no history,
    // no context transfer) when we can authenticate without the relay. HTTPS-
    // only — skipped for the relay AND for SSH key auth. Falls through to git
    // clone on ANY failure.
    if (!useHelper && !config.gitSsh) {
      const ref = config.commitSha || config.branch;
      const tarUrl = githubTarballUrl(config.repoUrl, ref);
      if (tarUrl) {
        try {
          log.log(`Fetching ${config.repoUrl} tarball on the server → ${remoteContextDir}...\n`);
          await downloadTarballOnRemote(executor, {
            url: tarUrl,
            token: config.gitToken,
            destDir: remoteContextDir,
            onLog: (entry) => log.log(entry.message, parseLogLevel(entry.message)),
          });
          // A tarball has no .git, but strip defensively in case a repo tracks one.
          await executor.exec(`rm -rf ${sq(`${remoteContextDir}/.git`)}`).catch(() => {});
          return;
        } catch (err) {
          log.log(
            `Tarball download failed (${safeErrorMessage(err)}); falling back to git clone.\n`,
            "warn",
          );
        }
      }
    }

    // SSH mode (per-server key / deploy key): write the 0600 key + known_hosts
    // on the remote out of band (executor.writeFile — never echoed) and clone
    // over git@github.com. Cleaned up in the finally below.
    let sshFiles: { keyFile: string; knownHostsFile: string } | undefined;
    let sshCleanup: string | null = null;
    if (config.gitSsh) {
      const sshDir = `${remoteContextDir}.gitssh`;
      const keyFile = `${sshDir}/id`;
      const knownHostsFile = `${sshDir}/known_hosts`;
      await executor.exec(`mkdir -p ${sq(sshDir)} && chmod 700 ${sq(sshDir)}`);
      await executor.writeFile(keyFile, config.gitSsh.privateKey);
      await executor.writeFile(knownHostsFile, config.gitSsh.knownHosts);
      await executor.exec(`chmod 600 ${sq(keyFile)}`);
      sshFiles = { keyFile, knownHostsFile };
      sshCleanup = `rm -rf ${sq(sshDir)}`;
    }

    // Centralized clone assembly (token / relay / ssh) — see git-clone.ts.
    const { cloneUrl, gitEnv: GIT_ENV, credFlag: CRED } = assembleGitClone({
      repoUrl: config.repoUrl,
      gitToken: config.gitToken,
      gitCredentialHelperPath: config.gitCredentialHelperPath,
      ssh: sshFiles,
    });
    const dir = sq(remoteContextDir);

    log.log(
      `Cloning ${config.repoUrl} on the server → ${remoteContextDir} ` +
        `(${config.gitSsh ? "ssh key" : useHelper ? "forwarded credentials" : "token"})...\n`,
    );
    await executor.exec(`rm -rf ${dir} && mkdir -p ${dir}`);

    const run = async (cmd: string) => {
      const { code } = await executor.streamExec(cmd, (entry) =>
        log.log(entry.message, parseLogLevel(entry.message)),
      );
      if (code !== 0) throw new Error(`git clone on server exited with code ${code}`);
    };

    try {
      if (config.commitSha) {
        try {
          await run(
            `${GIT_ENV} git ${CRED} clone --progress --depth 50 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${dir} && ` +
              `cd ${dir} && git ${CRED} -c advice.detachedHead=false checkout ${sq(config.commitSha)}`,
          );
        } catch {
          log.log(`Commit ${config.commitSha} not in the shallow clone; unshallowing and retrying.\n`, "warn");
          await run(
            `cd ${dir} && ${GIT_ENV} git ${CRED} fetch --progress --unshallow && ` +
              `git ${CRED} -c advice.detachedHead=false checkout ${sq(config.commitSha)}`,
          );
        }
      } else {
        await run(
          `${GIT_ENV} git ${CRED} clone --progress --depth 1 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${dir}`,
        );
      }
      // Never ship .git into the build image.
      await executor.exec(`rm -rf ${sq(`${remoteContextDir}/.git`)}`).catch(() => {});
    } finally {
      if (sshCleanup) await executor.exec(sshCleanup).catch(() => {});
    }
  }

  /**
   * Resolve the Dockerfile for a build whose source lives on the REMOTE host
   * (clone-on-server). Mirrors resolveServiceDockerfile but probes the remote
   * tree with `test -f` instead of the local FS: a repository Dockerfile
   * candidate is used when present; otherwise a Dockerfile is generated locally
   * (pure fn) and written to the remote tree. Returns the dockerfile path
   * relative to `remoteContextDir`.
   */
  private async resolveRemoteDockerfile(
    config: BuildConfig,
    remoteContextDir: string,
    generatedName: string,
    requireRepositoryDockerfile: boolean,
  ): Promise<string> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("Clone-on-server requires an SSH executor on connectionOptions");

    for (const candidate of resolveDockerfileCandidates(config.rootDirectory, config.dockerfilePath)) {
      const out = await executor
        .exec(`test -f ${sq(`${remoteContextDir}/${candidate}`)} && echo yes || true`)
        .catch(() => "");
      if (out.trim() === "yes") return candidate;
    }

    if (requireRepositoryDockerfile) {
      const expected = config.dockerfilePath?.trim() || "Dockerfile";
      throw new Error(
        `No Dockerfile found in the cloned repo. Expected ${expected}${config.rootDirectory ? ` under ${config.rootDirectory}` : ""}.`,
      );
    }

    // Generate one locally (pure function of config) and ship just the file.
    await executor.writeFile(`${remoteContextDir}/${generatedName}`, generateDockerfile(config));
    return generatedName;
  }

  private async buildViaSshTarPipe(
    config: BuildConfig,
    buildContext: Awaited<ReturnType<typeof createDockerBuildContext>>,
    tag: string,
    log: BuildLogger,
  ): Promise<void> {
    const remoteContextDir = `/tmp/openship-build-${config.sessionId}`;
    try {
      await this.transferBuildContext(buildContext.contextDir, remoteContextDir, log);
      await this.buildImageOnRemote(config, remoteContextDir, buildContext.dockerfileName, tag, log);
    } finally {
      // Always clean up the remote context - even on failure. Don't await - if
      // cleanup fails we still want the build result.
      this.connectionOptions?.executor
        ?.exec(`rm -rf ${sq(remoteContextDir)}`)
        .catch(() => { /* best effort */ });
      await buildContext.cleanup();
    }
  }

  /**
   * Dockerode build path. Used for local socket and TCP transports, plus
   * SSH transports that didn't get an executor wired in (shouldn't happen
   * in normal operation but kept as a safety net).
   *
   * This path is slower for SSH (HTTP-over-SSH upload has no streaming),
   * but it's correct for local/TCP where there's no separate SSH
   * connection to piggyback on.
   */
  private async buildViaDockerode(
    config: BuildConfig,
    buildContext: Awaited<ReturnType<typeof createDockerBuildContext>>,
    tag: string,
    log: BuildLogger,
  ): Promise<void> {
    log.log(`Streaming build context to Docker daemon - image tag: ${tag}`);

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

    log.log("Connected to Docker daemon. Build output follows:");
    await this.streamDockerodeBuild(stream, log);
    log.log("Docker daemon finished streaming build output. Finalizing image...\n");
  }

  /**
   * Consume a dockerode build stream: stream progress to the log, enforce the
   * idle timeout + keepalive, and throw on a fatal build event. Shared by the
   * single-image dockerode path and the local batch build (buildImages).
   */
  private async streamDockerodeBuild(
    stream: NodeJS.ReadableStream,
    log: BuildLogger,
  ): Promise<void> {
    let fatalBuildError: string | null = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let keepaliveTimer: NodeJS.Timeout | null = null;
      let idleMinutes = 0;

      const clearTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
        idleMinutes = 0;
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        (stream as any).destroy?.(error);
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve();
      };

      const resetIdleTimer = () => {
        clearTimers();
        keepaliveTimer = setInterval(() => {
          idleMinutes += 1;
          log.log(`Still building... (no output for ${idleMinutes}m)`);
        }, 60_000);
        if ((keepaliveTimer as any).unref) (keepaliveTimer as any).unref();

        idleTimer = setTimeout(() => {
          fail(new Error(
            "Docker build produced no output for 30 minutes. This usually means the remote server cannot reach the package registry, has broken DNS, or the Docker daemon stalled during the build.",
          ));
        }, DOCKER_BUILD_IDLE_TIMEOUT_MS);
        if ((idleTimer as any).unref) (idleTimer as any).unref();
      };

      resetIdleTimer();

      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) { fail(err); return; }
          succeed();
        },
        (event) => {
          resetIdleTimer();
          fatalBuildError ??= this.handleBuildEvent(event, log);
        },
      );
    });

    if (fatalBuildError) {
      throw new Error(fatalBuildError);
    }
  }

  /**
   * Confirm a just-built image actually exists before handing its tag back
   * as the deploy artifact.
   *
   * For SSH-transport builds, verify over the SAME pooled SSH exec channel
   * the `docker build` command itself just ran on — not `this.docker`
   * (dockerode), which for SSH transport talks over a SEPARATE, independently
   * -tunneled streamlocal bridge connection (see docker-ssh-agent.ts). That
   * second connection has proven unreliable in practice: it can hang
   * indefinitely or report the image missing even though `docker images` on
   * the box confirms it built successfully seconds earlier. Reusing the
   * already-proven-live exec channel avoids standing up a second, flakier
   * connection just to ask a question the first connection already knows
   * the answer to.
   *
   * For local-socket/TCP transports there is no separate bridge — `this.docker`
   * talks directly to the daemon — so the original dockerode check is fine
   * and stays as the fallback.
   */
  private async verifyImageBuilt(tag: string): Promise<void> {
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    try {
      if (executor) {
        await executor.exec(`docker image inspect ${sq(tag)} >/dev/null`);
      } else {
        await this.docker.getImage(tag).inspect();
      }
    } catch (cause) {
      throw new Error(`Docker build finished but the image ${tag} was not created`, { cause });
    }
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

      const sshExecutor =
        this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;

      // ── Clone-on-server path ───────────────────────────────────────────
      // Clone the repo ON the remote host and build there — no local clone and
      // no context transfer. Only for SSH server builds that opted in.
      if (sshExecutor && config.cloneOnServer) {
        const remoteContextDir = `/tmp/openship-build-${config.sessionId}`;
        try {
          this.emitDockerStep(log, "clone", "running", "Cloning source on the server...");
          await this.cloneSourceOnRemote(config, remoteContextDir, log);
          this.emitDockerStep(log, "clone", "completed", "Source cloned on the server");
          const dockerfileName = await this.resolveRemoteDockerfile(
            config,
            remoteContextDir,
            "Dockerfile.openship",
            config.stack === "docker",
          );
          await this.buildImageOnRemote(config, remoteContextDir, dockerfileName, tag, log);
        } finally {
          sshExecutor.exec(`rm -rf ${sq(remoteContextDir)}`).catch(() => { /* best effort */ });
        }

        await this.verifyImageBuilt(tag);
        log.log(`Image ${tag} is ready.\n`);
        log.step("build", "completed", `Finalizing image ${tag}`);
        return { sessionId: config.sessionId, status: "deploying", imageRef: tag, durationMs: Date.now() - startTime };
      }

      this.emitDockerStep(log, "clone", "running", "Preparing Docker build context...");

      const buildContext = await createDockerBuildContext(config, {
        requireRepositoryDockerfile: config.stack === "docker",
        onLog: log.callback,
      });

      // Report the size of the context so users know what they're paying
      // for over the SSH wire. Failure here is non-fatal - the build can
      // still proceed if we couldn't `du`.
      try {
        const sizeBytes = await this.estimateContextSize(buildContext.contextDir);
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
        this.emitDockerStep(
          log,
          "clone",
          "completed",
          `Docker build context ready (${sizeMB} MB)`,
        );
      } catch {
        this.emitDockerStep(log, "clone", "completed", "Docker build context ready");
      }

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

      if (sshExecutor) {
        // ── Fast SSH path ──────────────────────────────────────────────
        // Bypass dockerode for the upload - it tars and POSTs the context
        // as one HTTP body through SSH-tunneled-HTTP, which is ~1-2 MB/s.
        // Instead: use the same tar-over-SSH pipe bare deploys use (with
        // per-3s `~X% · Y MB sent · Z MB/s` progress), then run native
        // `docker build` on the remote so its real stdout/stderr streams
        // back uninterpreted.
        await this.buildViaSshTarPipe(config, buildContext, tag, log);
      } else {
        // ── Dockerode path (local socket, TCP, or SSH without executor) ─
        await this.buildViaDockerode(config, buildContext, tag, log);
      }

      await this.verifyImageBuilt(tag);

      log.log(`Image ${tag} is ready.\n`);
      log.log(`[build] ✓ Image ${tag} ready`);
      log.step("build", "completed", `Finalizing image ${tag}`);
      const durationMs = Date.now() - startTime;
      return { sessionId: config.sessionId, status: "deploying", imageRef: tag, durationMs };
    } catch (err) {
      const msg = safeErrorMessage(err);
      log.step("build", "failed", `Docker build failed: ${msg}`);
      return { sessionId: config.sessionId, status: "failed", durationMs: Date.now() - startTime, errorMessage: `Docker build failed: ${msg}` };
    }
  }

  /**
   * Batch build: clone + prune the shared source ONCE, then build every image
   * from that single tree. For SSH the context is transferred ONCE and each
   * image builds on the remote against it. Eliminates the per-service re-clone
   * / re-transfer that N separate build() calls incur — every service builds on
   * the SAME daemon, so the source only needs to arrive once.
   *
   * Prepare-phase logs (clone/transfer) go to `prepareLogger`; each image's
   * build output goes to its own `spec.logger`.
   */
  async buildImages(
    specs: Array<{
      config: BuildConfig;
      serviceName: string;
      logger: BuildLogger;
      requireRepositoryDockerfile?: boolean;
      onStart?: () => void;
      onResult?: (result: BuildResult) => void;
    }>,
    prepareLogger: BuildLogger,
  ): Promise<Array<{ serviceName: string; result: BuildResult }>> {
    if (specs.length === 0) return [];

    try {
      await this.ensureDockerFeature(prepareLogger);
    } catch (featureErr) {
      throw new Error(this.formatDockerConnectivityError(featureErr));
    }

    // Every service in a compose/monorepo build shares ONE repo+branch+commit,
    // so the first spec's source config drives the single clone.
    const source = specs[0]!.config;
    const isSsh = this.transport.kind === "ssh" && !!this.connectionOptions?.executor;
    const cloneOnServer = isSsh && !!source.cloneOnServer;
    const remoteContextDir = `/tmp/openship-build-${source.sessionId}`;

    // Acquire the shared source ONCE: clone-on-server clones directly on the
    // remote host (no transfer); otherwise clone on the orchestrator (and
    // transfer the tree below).
    let tree: Awaited<ReturnType<typeof prepareSourceTree>> | null = null;
    if (cloneOnServer) {
      prepareLogger.step("clone", "running", "Cloning source on the server...");
      await this.cloneSourceOnRemote(source, remoteContextDir, prepareLogger);
      prepareLogger.step("clone", "completed", "Source cloned on the server");
    } else {
      prepareLogger.step("clone", "running", "Preparing shared build context...");
      tree = await prepareSourceTree(source, { onLog: prepareLogger.callback });
    }

    try {
      // Resolve/generate each service's Dockerfile INTO the shared tree, with a
      // per-service generated name so concurrent builds never clobber each other.
      const resolvedList = await Promise.all(
        specs.map(async (spec) => {
          const generatedName = `Dockerfile.openship.${spec.config.sessionId}`;
          const requireRepo = spec.requireRepositoryDockerfile ?? spec.config.stack === "docker";
          try {
            if (cloneOnServer) {
              const dockerfileName = await this.resolveRemoteDockerfile(
                spec.config,
                remoteContextDir,
                generatedName,
                requireRepo,
              );
              return {
                spec,
                dockerfileName,
                contextEntries: null as string[] | null,
                error: null as string | null,
              };
            }
            const resolved = await resolveServiceDockerfile(tree!.contextDir, spec.config, {
              requireRepositoryDockerfile: requireRepo,
              generatedName,
            });
            return {
              spec,
              dockerfileName: resolved.dockerfileName,
              contextEntries: resolved.contextEntries,
              error: null as string | null,
            };
          } catch (err) {
            return {
              spec,
              dockerfileName: null as string | null,
              contextEntries: null as string[] | null,
              error: safeErrorMessage(err),
            };
          }
        }),
      );

      // Local-clone path: report context size + transfer the shared tree ONCE.
      // (clone-on-server already put the tree on the remote — nothing to transfer.)
      if (!cloneOnServer && tree) {
        try {
          const sizeBytes = await this.estimateContextSize(tree.contextDir);
          prepareLogger.step(
            "clone",
            "completed",
            `Shared build context ready (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
          );
        } catch {
          prepareLogger.step("clone", "completed", "Shared build context ready");
        }
        if (isSsh) {
          await this.transferBuildContext(tree.contextDir, remoteContextDir, prepareLogger);
        }
      }

      // Build each image against the shared tree ONE AT A TIME. Sequential is
      // deliberate: concurrent `docker build` over SSH contends for SSH channels
      // (nondeterministic which stream wins) and for server memory (parallel
      // `bun install`/`next build` OOMs a single box). Sequential also lets each
      // service's onStart fire in turn, so the UI's auto-follow lands on the ONE
      // service that's actually streaming. The expensive part (clone + transfer)
      // is already shared above; only the per-image build is serialized here.
      const results: Array<{ serviceName: string; result: BuildResult }> = [];
      for (const { spec, dockerfileName, contextEntries, error } of resolvedList) {
        const startedAt = Date.now();
        const tag = this.imageTag(spec.config.slug, spec.config.sessionId);

        if (error || !dockerfileName) {
          const result: BuildResult = {
            sessionId: spec.config.sessionId,
            status: "failed",
            durationMs: Date.now() - startedAt,
            errorMessage: error ?? "Failed to resolve Dockerfile",
          };
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
          continue;
        }

        // This image's build starts now — flip its status so the UI follows it.
        spec.onStart?.();

        try {
          if (isSsh) {
            await this.buildImageOnRemote(
              spec.config,
              remoteContextDir,
              dockerfileName,
              tag,
              spec.logger,
            );
          } else {
            const stream = await this.docker.buildImage(
              { context: tree!.contextDir, src: contextEntries ?? [] },
              {
                t: tag,
                dockerfile: dockerfileName,
                labels: this.labels({
                  projectId: spec.config.projectId,
                  sessionId: spec.config.sessionId,
                }),
                buildargs: { ...spec.config.envVars, NODE_ENV: "production" },
                forcerm: true,
              },
            );
            await this.streamDockerodeBuild(stream, spec.logger);
          }

          await this.verifyImageBuilt(tag);

          spec.logger.log(`Image ${tag} is ready.\n`);
          const result: BuildResult = {
            sessionId: spec.config.sessionId,
            status: "deploying",
            imageRef: tag,
            durationMs: Date.now() - startedAt,
          };
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
        } catch (err) {
          const msg = safeErrorMessage(err);
          spec.logger.log(`Docker build failed: ${msg}\n`, "error");
          const result: BuildResult = {
            sessionId: spec.config.sessionId,
            status: "failed",
            durationMs: Date.now() - startedAt,
            errorMessage: `Docker build failed: ${msg}`,
          };
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
        }
      }
      return results;
    } finally {
      if (isSsh) {
        this.connectionOptions?.executor
          ?.exec(`rm -rf ${sq(remoteContextDir)}`)
          .catch(() => { /* best effort */ });
      }
      if (tree) await tree.cleanup();
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

    const containerName = `openship-${config.runtimeName || config.projectId}-${config.deploymentId}`;

    // Environment variables
    const env = [
      `PORT=${config.port}`,
      `NODE_ENV=${config.environment === "production" ? "production" : "development"}`,
      ...Object.entries(config.envVars).map(([k, v]) => `${k}=${v}`),
    ];

    // Start command - if provided, split into Cmd array
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
        // Publish on the LOOPBACK interface only — the edge (host process, or a
        // host-net OpenResty container) reaches it at 127.0.0.1:<hostPort>, and
        // it never faces the network. Binding 0.0.0.0 here would expose every
        // app directly, bypassing the edge's SSL/rate-limit/rules (and Docker's
        // iptables bypass ufw). A pinned `config.hostPort` (loopback-port route
        // strategy) is stable across redeploys; otherwise a random loopback port.
        PortBindings: {
          [`${config.port}/tcp`]: [
            { HostIp: "127.0.0.1", HostPort: config.hostPort ? String(config.hostPort) : "" },
          ],
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

  async removeImage(imageRef: string): Promise<void> {
    const image = this.docker.getImage(imageRef);
    try {
      await image.remove({ force: true });
    } catch (err) {
      // Idempotent: swallow "not found" / 404 so partial-cleanup retries
      // don't re-fail on already-deleted images. Re-throw anything else
      // (permission denied, image in use by other tags, daemon down, ...).
      if (!isDockerNotFoundError(err)) throw err;
    }
  }

  async destroy(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    try {
      await container.remove({ force: true });
    } catch (err) {
      // Idempotent: swallow "no such container" / 404 so partial-cleanup
      // retries don't re-fail on already-deleted containers. Re-throw
      // anything else (permission denied, daemon down, dependent state).
      if (!isDockerNotFoundError(err)) throw err;
    }
  }

  /**
   * Every container (running OR stopped) labeled for this project. Lets
   * project teardown reclaim orphans that have no DB row — e.g. a deploy
   * that started a container then failed during routing, or rows lost to
   * a crash. The `openship.project` label is stamped at create time
   * (see `labels()`), so this is authoritative for THIS docker host.
   */
  async listProjectContainerIds(projectId: string): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`openship.project=${projectId}`] },
    });
    return containers.map((c) => c.Id);
  }

  /**
   * Containers labeled for this deployment, with live state — the reconcile
   * read-back. `State` is dockerode's `running | exited | paused | ...`; map it
   * to ContainerStatus the same way getContainerInfo does. Absence is conveyed
   * by an EMPTY list (no container carries the label), which the reconciler
   * reads as drift for the expected services.
   */
  async listDeploymentContainers(
    deploymentId: string,
  ): Promise<Array<{ containerId: string; status: ContainerStatus; serviceName?: string }>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`openship.deployment=${deploymentId}`] },
    });
    const stateMap: Record<string, ContainerStatus> = {
      running: "running",
      healthy: "running",
      starting: "running",
      restarting: "running",
      exited: "stopped",
      paused: "stopped",
      created: "stopped",
      dead: "failed",
      unhealthy: "failed",
    };
    return containers.map((c) => ({
      containerId: c.Id,
      status: stateMap[(c.State ?? "").toLowerCase().trim()] ?? "stopped",
      serviceName: c.Labels?.["openship.service"],
    }));
  }

  // ── Rollback primitives ──────────────────────────────────────────────
  //
  // Docker semantics:
  //   makeActive — prefer `start` of the retained container (fast,
  //     preserves PID/state). If the container was GC'd but the image
  //     is still tagged, `run` from imageRef to provision a fresh
  //     container. Stop the previous active as part of the swap.
  //   archive   — `docker stop`. Image stays tagged. Container kept
  //     for fast restart on later makeActive.
  //   purge     — `docker rm` (force) + `docker rmi`. Past this point
  //     rollback to this deployment is impossible.

  async makeActive(input: RollbackInput): Promise<MakeActiveResult> {
    // 1) Stop the currently-active deployment (if any) so we don't have
    //    two containers serving the same port. Errors here are non-fatal
    //    — if the previous container is already gone the swap continues.
    if (input.from?.containerId) {
      try {
        await this.stop(input.from.containerId);
      } catch {
        // already stopped / gone — ignore
      }
    }

    // 2) Try fast-start the target's existing container.
    if (input.to.containerId) {
      try {
        await this.start(input.to.containerId);
        return { containerId: input.to.containerId };
      } catch {
        // container missing — fall through to run-from-image
      }
    }

    // 3) Container is gone but image is still tagged: provision a fresh
    //    container from the retained image. Same parameters the original
    //    deploy used — but we don't have the full DeployConfig here, so
    //    we use minimal defaults. If the orchestrator needs richer
    //    re-provisioning it can call `deploy()` instead.
    if (!input.to.imageRef) {
      throw new Error(
        `Cannot make deployment ${input.to.id} active: container is gone and no imageRef is stored. Artifact has been purged.`,
      );
    }
    const container = await this.docker.createContainer({
      Image: input.to.imageRef,
      name: `dep-${input.to.id}`,
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    });
    await container.start();
    return { containerId: container.id };
  }

  async archive(deployment: DeploymentRef): Promise<void> {
    // Docker archive = stop the container. Image + stopped container
    // are preserved on the host until purge.
    if (!deployment.containerId) return; // already archived (no container) or never deployed
    try {
      await this.stop(deployment.containerId);
    } catch {
      // already stopped — ignore
    }
  }

  async purge(deployment: DeploymentRef): Promise<void> {
    // Purge order: remove container first (best-effort), then image.
    // Container removal silently no-ops if already gone — keeps purge
    // idempotent across replays.
    if (deployment.containerId) {
      try {
        await this.destroy(deployment.containerId);
      } catch {
        // already removed
      }
    }
    if (deployment.imageRef) {
      try {
        await this.removeImage(deployment.imageRef);
      } catch {
        // image already removed / not present locally
      }
    }
  }

  /**
   * Inspect a container and return the names of its **named** volumes -
   * the ones that survive `container.remove()` and would otherwise leak.
   * Anonymous volumes are auto-removed with `{ v: true }` and don't need to
   * be enumerated. Bind mounts and tmpfs are skipped (the user manages them
   * outside our control). Returns [] if the container is already gone.
   */
  async inspectNamedVolumes(containerId: string): Promise<string[]> {
    try {
      const container = this.docker.getContainer(containerId);
      const data = await container.inspect();
      const mounts = (data.Mounts ?? []) as Array<{ Type?: string; Name?: string }>;
      return mounts
        .filter((m) => m.Type === "volume" && typeof m.Name === "string" && m.Name.length > 0)
        .map((m) => m.Name as string);
    } catch {
      return [];
    }
  }

  /** Remove a named volume by name. Best-effort - already-gone is fine. */
  async removeVolume(name: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(name);
      await volume.remove({ force: true });
    } catch {
      // Already removed, in-use elsewhere, or doesn't exist.
    }
  }

  // ── Docker discovery (label-agnostic) ────────────────────────────────────
  //
  // Enumerate the ENTIRE daemon, not just openship-labeled resources. Powers
  // "migrate an existing Docker deployment": read whatever already runs on a
  // server (a compose stack or hand-run containers) so it can be adopted as an
  // Openship project. Strictly read-only.

  /** Every container on the host (running or stopped), summarized. */
  async listAllContainers(): Promise<DockerContainerSummary[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.map((c) => {
      const labels = c.Labels ?? {};
      return {
        id: c.Id,
        names: (c.Names ?? []).map((n) => n.replace(/^\//, "")),
        image: c.Image,
        imageId: c.ImageID,
        state: (c.State ?? "").toLowerCase().trim(),
        status: c.Status,
        labels,
        ports: (c.Ports ?? []).map((p) => ({
          privatePort: p.PrivatePort,
          ...(p.PublicPort ? { publicPort: p.PublicPort } : {}),
          type: (p.Type as string) ?? "tcp",
          ...(p.IP ? { ip: p.IP } : {}),
        })),
        mounts: (c.Mounts ?? []).map(normalizeDockerMount),
        composeProject: labels["com.docker.compose.project"] || undefined,
        composeService: labels["com.docker.compose.service"] || undefined,
      };
    });
  }

  /** Full inspect of one container, normalized. Null if the container is gone. */
  async inspectContainer(id: string): Promise<DockerContainerDetail | null> {
    let data: Dockerode.ContainerInspectInfo;
    try {
      data = await this.docker.getContainer(id).inspect();
    } catch (err) {
      if (isDockerNotFoundError(err)) return null;
      throw err;
    }
    const labels = data.Config?.Labels ?? {};
    const hc = data.Config?.Healthcheck;
    const rp = data.HostConfig?.RestartPolicy;
    const configFiles = labels["com.docker.compose.project.config_files"];
    return {
      id: data.Id,
      name: (data.Name ?? "").replace(/^\//, ""),
      image: data.Config?.Image ?? data.Image,
      imageId: data.Image,
      state: (data.State?.Status ?? "").toLowerCase().trim() || "unknown",
      command: toStringArray(data.Config?.Cmd),
      entrypoint: toStringArray(data.Config?.Entrypoint),
      env: data.Config?.Env ?? [],
      workingDir: data.Config?.WorkingDir || undefined,
      labels,
      restart: rp?.Name ? { name: rp.Name, maximumRetryCount: rp.MaximumRetryCount } : undefined,
      networks: Object.keys(data.NetworkSettings?.Networks ?? {}),
      mounts: (data.Mounts ?? []).map(normalizeDockerMount),
      ports: normalizeInspectPorts(data),
      healthcheck: hc
        ? {
            test: hc.Test,
            interval: hc.Interval,
            timeout: hc.Timeout,
            retries: hc.Retries,
            startPeriod: hc.StartPeriod,
          }
        : undefined,
      composeProject: labels["com.docker.compose.project"] || undefined,
      composeService: labels["com.docker.compose.service"] || undefined,
      composeConfigFiles: configFiles
        ? configFiles.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      composeWorkingDir: labels["com.docker.compose.project.working_dir"] || undefined,
    };
  }

  /** The image's baked-in default env (Config.Env). Discovery subtracts these
   *  from a container's env so only user-set vars are imported, not the dozen
   *  defaults a base image (postgres, node, …) ships with. [] if unavailable. */
  async inspectImageEnv(ref: string): Promise<string[]> {
    try {
      const data = await this.docker.getImage(ref).inspect();
      return data.Config?.Env ?? [];
    } catch {
      return [];
    }
  }

  /** The image's baked-in default CMD (exec-form tokens). Used by migration to
   *  drop a container's `command` when it merely restates the image default —
   *  re-specifying it (and wrapping in `sh -c`) defeats entrypoints that drop
   *  privileges by argv (postgres refuses to run as root otherwise). */
  async inspectImageCmd(ref: string): Promise<string[]> {
    try {
      const data = await this.docker.getImage(ref).inspect();
      return data.Config?.Cmd ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Ensure an image is present, pulling it if missing. THE single image-pull
   * path — reused by the deploy pipeline and the backup/migration executor so
   * connectivity lives in one place.
   *
   * Over an SSH transport the pull runs as a blocking `docker pull` through the
   * command executor, NOT dockerode's `pull` + `modem.followProgress`: the
   * progress stream tunneled over the SSH docker socket never emits `end`, so
   * followProgress hangs forever (this was the cross-server migration stall).
   * A local socket has no such issue, so it keeps the native dockerode pull.
   */
  async pullImage(ref: string, opts?: { force?: boolean }): Promise<void> {
    if (!opts?.force) {
      try {
        await this.docker.getImage(ref).inspect();
        return; // already present
      } catch {
        /* missing → pull below */
      }
    }
    // force → skip the present-check and always pull the tag, so a moved
    // mutable tag (:latest/:1) rolls forward on an "update" deploy.
    const executor = this.connectionOptions?.executor;
    if (executor) {
      // 10 min ceiling — large images over a slow link; still bounded so a
      // genuinely stuck pull surfaces instead of hanging the whole migration.
      await executor.exec(`docker pull ${sq(ref)}`, { timeout: 10 * 60_000 });
      return;
    }
    const stream = await this.docker.pull(ref);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Every named volume on the host. */
  async listAllVolumes(): Promise<DockerVolumeInfo[]> {
    const res = await this.docker.listVolumes();
    return (res?.Volumes ?? []).map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      labels: v.Labels ?? {},
      composeProject: v.Labels?.["com.docker.compose.project"] || undefined,
    }));
  }

  /** Every network on the host. */
  async listAllNetworks(): Promise<DockerNetworkInfo[]> {
    const nets = await this.docker.listNetworks();
    return nets.map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      labels: n.Labels ?? {},
      composeProject: n.Labels?.["com.docker.compose.project"] || undefined,
    }));
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const container = this.docker.getContainer(containerId);
    let data: Dockerode.ContainerInspectInfo;
    try {
      data = await container.inspect();
    } catch (err) {
      // ABSENT: the daemon has no such container — it was removed out-of-band.
      // Report `missing` (drift) rather than throwing; a genuine connection
      // failure (unreachable host) is NOT 404 and still propagates so callers
      // can tell "gone" from "can't reach".
      if (isDockerNotFoundError(err)) {
        return { containerId, status: "missing" };
      }
      throw err;
    }

    const statusMap: Record<string, ContainerInfo["status"]> = {
      running: "running",
      healthy: "running",
      starting: "running",
      restarting: "running",
      exited: "stopped",
      paused: "stopped",
      created: "stopped",
      dead: "failed",
      unhealthy: "failed",
    };

    const startedAt = data.State.StartedAt;
    const uptimeSeconds = startedAt && data.State.Running
      ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
      : undefined;

    const { ip, hostPort } = extractNetworkInfo(data);

    let status: ContainerInfo["status"];
    if (data.State.Running) {
      status = "running";
    } else if (data.State.Paused) {
      status = "stopped";
    } else {
      const rawStatus = (data.State.Status ?? "").toLowerCase().trim();
      status = statusMap[rawStatus] ?? "stopped";
    }

    return {
      containerId,
      status,
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

    const raw = stripDockerHeaders(buffer);

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const { timestamp, message } = parseTimestampedLine(line);
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

    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      if (destroyed) return;
      buffer += stripDockerChunkHeader(chunk).toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const { timestamp, message } = parseTimestampedLine(line);
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
        (stream as any).destroy?.();
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

  /**
   * Open an interactive PTY shell inside a deployed container. Powers
   * the in-dashboard service terminal — see apps/api/src/modules/service-terminal/.
   *
   * Wire-up: dockerode's `container.exec({Tty: true, AttachStdin: true,
   * AttachStdout: true, AttachStderr: true})` returns an Exec handle.
   * Starting it with `{hijack: true, stdin: true}` gives a single bi-
   * directional Duplex carrying TTY bytes in both directions (when Tty
   * is true, stderr is merged into stdout — exactly what xterm expects).
   *
   * The returned ShellSession matches SshExecutor.openShell so the
   * websocket bridge in service-terminal.controller.ts is identical
   * across Docker + Cloud + SSH callers.
   */
  async openServiceShell(
    containerId: string,
    opts?: ShellOptions,
  ): Promise<ShellSession> {
    const container = this.docker.getContainer(containerId);
    const cols = clampShellWindow(opts?.cols, 80, 1, 1000);
    const rows = clampShellWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    // Probe shell availability: prefer bash, fall back to sh. Both
    // are safe to invoke as `cmd -c env-prefix exec target-shell` so
    // the chosen shell ends up as PID 1 of the exec (clean exit
    // semantics — closing stdin from the WS terminates the shell).
    const inspect = await container.inspect().catch(() => null);
    if (!inspect?.State.Running) {
      throw new Error(
        `Container ${containerId} is not running (status: ${inspect?.State.Status ?? "unknown"})`,
      );
    }

    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ["/bin/sh", "-lc", "exec $(command -v bash || echo /bin/sh)"],
      Env: [`TERM=${term}`],
    });

    // `hijack: true` lifts the underlying TCP connection out of HTTP
    // and gives us a raw Duplex. With Tty:true the stream carries the
    // PTY bytes without dockerode's multiplexing frame header.
    const duplex = (await exec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    })) as import("node:stream").Duplex;

    // Set the initial window. Dockerode's resize() POSTs
    // /exec/{id}/resize?h={rows}&w={cols}. Safe to call before any
    // data flows.
    try {
      await exec.resize({ h: rows, w: cols });
    } catch {
      // ignore — the shell will still work at its default size
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    duplex.on("data", (chunk: Buffer) => stdout.write(chunk));
    duplex.on("end", () => {
      stdout.end();
      stderr.end();
    });
    duplex.on("error", () => {
      stdout.end();
      stderr.end();
    });

    const stdin = new Writable({
      write(chunk, _enc, cb) {
        duplex.write(chunk, (err) => cb(err ?? undefined));
      },
      final(cb) {
        try {
          duplex.end();
        } catch {
          // already ended
        }
        cb();
      },
    });

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try {
          cb(code, signal);
        } catch {
          /* listener bug shouldn't kill cleanup */
        }
      }
    };

    duplex.on("close", () => {
      // Best-effort exit-code lookup. exec.inspect() returns the code
      // for a finished exec; null/undefined means we couldn't reach
      // dockerd in time (network blip, container gone) — surface as -1.
      exec
        .inspect()
        .then((info) => fireClose(info.ExitCode ?? null))
        .catch(() => fireClose(null));
    });

    return {
      stdin,
      stdout,
      stderr,
      setWindow: (c, r) => {
        const sc = clampShellWindow(c, 80, 1, 1000);
        const sr = clampShellWindow(r, 24, 1, 500);
        // resize() returns a promise we deliberately ignore — the WS
        // bridge calls this on every resize event, swallowing the
        // promise prevents an unhandled rejection if the exec has
        // already exited.
        void exec.resize({ h: sr, w: sc }).catch(() => undefined);
      },
      close: (_signal?: string) => {
        try {
          duplex.end();
        } catch {
          /* already ended */
        }
        try {
          duplex.destroy();
        } catch {
          /* already destroyed */
        }
      },
      onClose: (cb) => {
        closeListeners.push(cb);
      },
    };
  }

  /**
   * Non-interactive one-shot exec INSIDE a container (Tty:false ⇒ dockerode
   * multiplexes stdout/stderr, so demux the frames). Sibling of
   * `openServiceShell` for the advisory port probe — reads stdout + the exit
   * code. Runs in the CONTAINER, not on the daemon host (never use
   * `this.executor` here).
   */
  private async execInContainer(
    containerId: string,
    command: string,
  ): Promise<{ exitCode: number | null; stdout: string }> {
    const container = this.docker.getContainer(containerId);
    const inspect = await container.inspect().catch(() => null);
    if (!inspect?.State.Running) {
      throw new Error(
        `Container ${containerId} is not running (status: ${inspect?.State.Status ?? "unknown"})`,
      );
    }

    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["sh", "-c", command],
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutChunks: Buffer[] = [];
    const stdoutSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        stdoutChunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const stderrSink = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });

    const info = await exec.inspect().catch(() => null);
    return {
      exitCode: info?.ExitCode ?? null,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    };
  }

  /** Command runner scoped to the inside of the container (advisory port probe). */
  async inContainerExecutor(containerId: string): Promise<PortProbeExecutor> {
    return {
      exec: async (command: string) => {
        const { exitCode, stdout } = await this.execInContainer(containerId, command);
        if (exitCode && exitCode !== 0) {
          throw new Error(stdout || `exec exited with code ${exitCode}`);
        }
        return stdout;
      },
    };
  }

  // ── Compose / multi-service ────────────────────────────────────────────

  /**
   * Ensure a project-level Docker network exists.
   * All services in a compose project share this network and can
   * reach each other by service name as hostname.
   */
  async ensureNetwork(slug: string): Promise<string> {
    const networkName = `openship-${slug}`;
    // list-then-create is check-then-act: two concurrent deploys for the same
    // slug would both miss and both create, yielding two networks with the same
    // name (Docker allows it) and ambiguous name lookups. Serialize per server.
    const critical = async () => {
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
    };
    return this.provisionLock ? this.provisionLock.run(critical) : critical();
  }

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
  }): Promise<MultiServiceGroupHandle> {
    void config.deploymentId;
    const networkId = await this.ensureNetwork(config.slug);
    // Self-heal network membership. A container joins the network only at
    // CREATE time (see deployServiceWorkload). Normal/partial/smart redeploys
    // are fine — the network is reused by name so its id is stable and
    // survivors stay attached. This covers the narrow case where the network's
    // identity changed out-of-band (docker network prune/rm, daemon/host
    // rebuild): survivors fall off it and become unreachable by name
    // (ESERVFAIL). Reconnecting every project container here, once per deploy,
    // makes membership independent of that.
    await this.reconcileNetworkMembership(networkId, config.projectId);
    return { id: networkId };
  }

  /**
   * Guard for GRANDFATHERED (non-namespaced) services: a bare named volume that
   * another project's container already mounts is a cross-project collision —
   * the exact bug (two projects sharing one postgres volume) this change
   * prevents for new services. New namespaced services can't hit this (their
   * volume name is project-unique by construction).
   *
   * Only a FRESH claim is blocked: if THIS project already mounts the name
   * (it's the incumbent) a redeploy is never blocked — otherwise, during an
   * active collision, whichever owner redeployed first would be locked out of
   * its own release. Best-effort on the list call; throws ONLY on a real
   * newcomer collision so the operator renames it.
   */
  private async assertNoForeignNamedVolumeCollision(
    config: MultiServiceDeployConfig,
  ): Promise<void> {
    const named = new Set<string>();
    for (const spec of config.volumes) {
      const body = spec.replace(/:(ro|rw|z|Z|nocopy)$/, "");
      const parts = body.split(":");
      if (parts.length < 2) continue; // anonymous / bare container path
      const source = parts[0];
      if (isHostPathSource(source)) continue; // bind mount
      named.add(source);
    }
    if (named.size === 0) return;

    let containers: Awaited<ReturnType<typeof this.docker.listContainers>>;
    try {
      containers = await this.docker.listContainers({ all: true });
    } catch {
      return; // never block a deploy on a docker list hiccup
    }

    // Names THIS project already mounts → it's the incumbent, never blocked.
    // Only a name held solely by ANOTHER project is a collision.
    const ownNames = new Set<string>();
    const foreign = new Map<string, string>(); // volume name → other container name
    for (const c of containers) {
      const owner = c.Labels?.["openship.project"];
      if (!owner) continue;
      for (const m of c.Mounts ?? []) {
        if (m.Type !== "volume" || !m.Name || !named.has(m.Name)) continue;
        if (owner === config.projectId) ownNames.add(m.Name);
        else if (!foreign.has(m.Name)) foreign.set(m.Name, c.Names?.[0]?.replace(/^\//, "") ?? owner);
      }
    }
    for (const [name, other] of foreign) {
      if (ownNames.has(name)) continue; // incumbent — allow the owner's redeploy
      throw new Error(
        `Volume "${name}" is already used by another project's container "${other}". ` +
          `Rename this service's volume to a project-unique name before deploying, ` +
          `to avoid overwriting the other project's data.`,
      );
    }
  }

  /**
   * Ensure every container belonging to this project is attached to
   * `networkId` with its service-name alias. Idempotent (already-connected is a
   * no-op) and best-effort (never throws). Normal/partial/smart redeploys don't
   * strand containers (the network is reused by name → stable id); this heals
   * the narrow case where the network's identity changed out-of-band (docker
   * network prune/rm, daemon/host rebuild) and surviving containers fell off it.
   */

  private async reconcileNetworkMembership(
    networkId: string,
    projectId: string,
  ): Promise<void> {
    let containers: Awaited<ReturnType<typeof this.docker.listContainers>>;
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`openship.project=${projectId}`] },
      });
    } catch {
      return;
    }
    const network = this.docker.getNetwork(networkId);
    for (const c of containers) {
      // Skip containers already on this exact network object.
      const onNetwork = Object.values(c.NetworkSettings?.Networks ?? {}).some(
        (n) => n?.NetworkID === networkId,
      );
      if (onNetwork) continue;
      const service = c.Labels?.["openship.service"];
      try {
        await network.connect({
          Container: c.Id,
          EndpointConfig: service ? { Aliases: [service] } : {},
        });
      } catch (err) {
        // "already exists in network" races are fine; anything else is
        // swallowed — reconcile is best-effort and must not block deploy.
        const msg = (err as { message?: string })?.message ?? "";
        if (!/already exists|already connected/i.test(msg)) {
          // best-effort: leave a breadcrumb, don't throw
          console.warn(
            `[docker] reconcile connect failed for ${c.Id.slice(0, 12)} → ${networkId.slice(0, 12)}: ${msg}`,
          );
        }
      }
    }
  }

  /**
   * Attach every container of `projectId` to the given networks (by name) — for
   * cross-project service links: a consumer joins a linked database app's
   * `openship-<slug>` network so it resolves that app's service alias
   * (`mongo:27017`) with no public port. Best-effort + idempotent; a network that
   * doesn't exist (source not deployed) is skipped and nothing here ever throws —
   * a link networking failure must never fail the consumer's deploy.
   */
  async attachToExternalNetworks(projectId: string, networkNames: string[]): Promise<void> {
    if (networkNames.length === 0) return;
    let containers: Awaited<ReturnType<typeof this.docker.listContainers>>;
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`openship.project=${projectId}`] },
      });
    } catch {
      return;
    }
    for (const name of networkNames) {
      const network = this.docker.getNetwork(name);
      let netId: string;
      try {
        const info = await network.inspect();
        netId = info.Id;
      } catch {
        continue; // network absent (source app not deployed) — skip
      }
      for (const c of containers) {
        const onNetwork = Object.values(c.NetworkSettings?.Networks ?? {}).some(
          (n) => n?.NetworkID === netId,
        );
        if (onNetwork) continue;
        try {
          await network.connect({ Container: c.Id });
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "";
          if (!/already exists|already connected/i.test(msg)) {
            console.warn(
              `[docker] link-connect failed for ${c.Id.slice(0, 12)} → ${name}: ${msg}`,
            );
          }
        }
      }
    }
  }

  /** Remove a project network (best-effort). */
  async removeNetwork(slug: string): Promise<void> {
    const networkName = `openship-${slug}`;
    try {
      const network = this.docker.getNetwork(networkName);
      await network.remove();
    } catch {
      // Already removed or doesn't exist - fine
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
      // Does not exist - fine
    }

    // Environment variables. Inject PORT=<service port> (like the single-app
    // deploy path) so an app that binds `process.env.PORT` listens on the port
    // the route proxies to — otherwise a monorepo/compose backend (e.g. Express
    // `PORT || 5000`) binds a default that doesn't match its route → 502. Never
    // override a PORT the service already sets.
    const env = [
      ...(config.publicPort && config.environment.PORT === undefined
        ? [`PORT=${config.publicPort}`]
        : []),
      ...Object.entries(config.environment).map(([k, v]) => `${k}=${v}`),
    ];

    // Command
    const cmd = config.command
      ? ["sh", "-c", config.command]
      : undefined;

    // Port bindings
    const { exposedPorts, portBindings } = parsePortBindings(config.ports);

    // Project-scope NAMED volumes (openship-<slug>-<name>) so two projects can
    // never share one docker volume; bind mounts / anonymous volumes pass
    // through. Grandfathered services (namespaceVolumes=false) keep their bare
    // names — for those, fail fast if a bare name already belongs to another
    // project (the exact class of bug this change prevents going forward).
    if (!config.namespaceVolumes) {
      await this.assertNoForeignNamedVolumeCollision(config);
    }
    const scopedBinds = scopeVolumeBinds(config.slug, config.volumes, config.namespaceVolumes);
    const binds = scopedBinds.length > 0 ? scopedBinds : undefined;

    const restartPolicy = resolveRestartPolicy(config.restart);
    const healthcheck = toDockerHealthcheck(config.advanced?.healthcheck);

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
        // Shared pull path — blocking `docker pull` over SSH so a first-time
        // pull on a fresh remote server can't hang (followProgress-over-SSH).
        // force-pull on the "update" trigger to roll a moved mutable tag forward.
        await this.pullImage(config.image, { force: config.forcePull });
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
      ...(healthcheck && { Healthcheck: healthcheck }),
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

    // Record the content-addressable digest actually running so the update
    // scanner can later detect a moved mutable tag. Best-effort: a locally-built
    // image has no RepoDigests, and any inspect failure must not fail the deploy.
    const imageDigest = await this.resolveImageDigest(config.image).catch(() => undefined);

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
      imageDigest,
    };
  }

  /**
   * Resolve the `repo@sha256:…` digest of a pulled image from its RepoDigests,
   * preferring the entry whose repo matches `ref` (an image may carry digests
   * for several repos). Returns undefined for a locally-built image (no
   * RepoDigests) or any inspect error. Works local + SSH (plain inspect, no
   * followProgress). Never throws.
   */
  private async resolveImageDigest(ref: string): Promise<string | undefined> {
    const info = await this.docker.getImage(ref).inspect();
    const repoDigests: string[] = (info as { RepoDigests?: string[] })?.RepoDigests ?? [];
    if (repoDigests.length === 0) return undefined;
    // repo = ref without tag/digest (a colon after the last slash is the tag).
    const noDigest = ref.split("@")[0];
    const lastColon = noDigest.lastIndexOf(":");
    const lastSlash = noDigest.lastIndexOf("/");
    const repo = lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
    return repoDigests.find((d) => d.startsWith(`${repo}@`)) ?? repoDigests[0];
  }

  async deployService(
    config: MultiServiceDeployConfig & { networkId: string },
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    return this.deployServiceWorkload({ id: config.networkId }, config, onLog);
  }
}
