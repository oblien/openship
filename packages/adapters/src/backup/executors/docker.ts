/**
 * DockerBackupExecutor — backup primitives for Docker-managed services.
 *
 * Strategy: helper container with `--volumes-from <target> -v <volume>:/mnt`
 * runs tar inside the same volume namespace as the target service.
 * Stdout of the helper container is a tar.gz stream that the orchestrator
 * pipes to the destination — bytes never land on the API host.
 *
 * The helper image is `alpine:3` (already present on most Docker hosts;
 * pulled once if missing). It carries busybox tar + the script we exec
 * directly (no `--volumes-from` mounting trickery beyond what dockerode
 * already exposes through HostConfig).
 */

import type Dockerode from "dockerode";
import { PassThrough, Readable } from "node:stream";
import { DockerRuntime } from "../../runtime/docker";
import { isHostPathSource, scopedVolumeName } from "../../runtime/volume-namespace";
import { registerExecutor } from "../registry";
import type {
  BackupExecutor,
  BackupSource,
  ExecuteCommandOpts,
  ExecExitInfo,
  ReceiveStreamOpts,
  ServiceHandle,
  StreamPathOpts,
} from "../types";

const HELPER_IMAGE = "alpine:3";

/** Single-quote shell escape — safe for arbitrary user-supplied
 *  values passed to `sh -c`. Wraps in single quotes and replaces any
 *  inner ' with the standard '\'' sequence. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Compression options exposed by the busybox+zstd alpine image. */
function compressionFlag(compression: "zstd" | "gzip" | "none" | undefined): string {
  switch (compression) {
    case "gzip":
      return "z";
    case "zstd":
      // busybox tar doesn't speak zstd directly; we pipe through `zstd -c`
      // — handled separately in the command builder below.
      return "";
    case "none":
    default:
      return "";
  }
}

/** Parse a compose-syntax volume string into the executor's source shape. */
function parseVolumeSpec(spec: string): { source: string; target: string; type: BackupSource["type"] } | null {
  // Strip mode suffix (":ro" / ":rw" etc.)
  const noMode = spec.replace(/:(ro|rw|z|Z|nocopy)$/, "");
  const parts = noMode.split(":");
  if (parts.length === 1) {
    // Anonymous volume — bare container path. Not backupable in v1
    // (Docker auto-removes anonymous volumes with the container).
    return { source: "", target: parts[0], type: "tmpfs" };
  }
  const [source, target] = parts;
  // A source that looks like a host path (/, ./, ../, ~) is a bind mount.
  // Otherwise treat as a named volume. Delegates to the shared classifier so
  // the deploy path and this classifier agree (incl. the ~ case).
  const type: BackupSource["type"] = isHostPathSource(source) ? "bind" : "volume";
  return { source, target, type };
}

export class DockerBackupExecutor implements BackupExecutor {
  readonly runtimeName = "docker" as const;

  constructor(private readonly runtime: DockerRuntime) {}

  private get dockerode(): Dockerode {
    return this.runtime.docker;
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    // Two sources of truth:
    //  1. Live container's actual Mounts (authoritative when the
    //     service is deployed). Captures Docker's resolution of relative
    //     paths and named-volume namespacing.
    //  2. service.volumes from the DB (fallback when the container
    //     isn't running or doesn't exist yet).
    if (service.containerId) {
      try {
        const data = await this.dockerode
          .getContainer(service.containerId)
          .inspect();
        const mounts = (data.Mounts ?? []) as Array<{
          Type?: string;
          Name?: string;
          Source?: string;
          Destination?: string;
        }>;
        return mounts
          .filter((m) => m.Type === "volume" || m.Type === "bind")
          .map((m, i): BackupSource => ({
            id: m.Name ?? m.Source ?? `mount-${i}`,
            target: m.Destination ?? "",
            source: m.Name ?? m.Source ?? "",
            type: (m.Type as BackupSource["type"]) ?? "volume",
          }));
      } catch {
        // Container gone — fall through to the DB-declared volumes.
      }
    }

    return service.volumes
      .map((spec, i): BackupSource | null => {
        const parsed = parseVolumeSpec(spec);
        if (!parsed || !parsed.source) return null;
        // Named volumes are project-scoped at deploy time; resolve the SAME
        // name here so the fallback mounts the real volume (not an empty one
        // docker would auto-create). Bind mounts and grandfathered services
        // (namespaceVolumes=false) keep the raw source.
        const source =
          parsed.type === "volume" && service.namespaceVolumes
            ? scopedVolumeName(service.projectSlug, parsed.source)
            : parsed.source;
        return {
          id: `${source}-${i}`,
          source,
          target: parsed.target,
          type: parsed.type,
        };
      })
      .filter((x): x is BackupSource => x !== null);
  }

  async execStream(
    service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    if (!service.containerId) {
      throw new Error(
        `Cannot exec in service ${service.name}: no containerId. Service must be deployed.`,
      );
    }

    const container = this.dockerode.getContainer(service.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      User: opts?.user,
      WorkingDir: opts?.cwd,
      Env: opts?.env
        ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    return this.attachDemuxed(this.dockerode, exec.id, stream, opts?.timeoutMs);
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    const sources = await this.listSources(service);
    const source = sources.find((s) => s.id === sourceId);
    if (!source) {
      throw new Error(`Backup source "${sourceId}" not found on service ${service.name}`);
    }
    if (source.type === "tmpfs") {
      throw new Error(`Backup source "${sourceId}" is tmpfs — not backupable`);
    }

    // Build the helper container command. Tar reads from /mnt and writes
    // to stdout. zstd compression is piped externally because busybox
    // doesn't link it.
    const compression = opts?.compression ?? "zstd";
    // shellEscape each pattern — these flow from user-facing fields,
    // an unescaped `; rm -rf /` would inject. tar's glob handling is
    // unchanged because the shell strips the quotes before exec.
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => [
      "--exclude",
      shellEscape(p),
    ]);
    const tarFlags = compressionFlag(compression);
    const tarCmd =
      compression === "zstd"
        ? `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} . | zstd -c -3`
        : `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} .`;
    const helperImage = compression === "zstd" ? "alpine:3" : HELPER_IMAGE;

    await this.ensureImage(helperImage);

    const hostConfig: Dockerode.HostConfig = {
      Binds: [`${source.source}:/mnt:ro`],
      AutoRemove: true,
      // The archive streams over `attach()` below — the daemon's default
      // json-file driver would ALSO write every byte of it to
      // /var/lib/docker/containers as a log. That's a second copy of the whole
      // backup, and worse than a copy: json-file escapes binary, so a 4.6 GB
      // volume ballooned to a 12 GB log file here. Backups then spike the
      // host's disk by more than the data they read and only release it when
      // the helper exits. Nothing ever reads these logs.
      LogConfig: { Type: "none", Config: {} },
    };

    const helper = await this.dockerode.createContainer({
      Image: helperImage,
      Cmd: ["sh", "-c", compression === "zstd" ? `apk add --no-cache zstd >/dev/null 2>&1; ${tarCmd}` : tarCmd],
      HostConfig: hostConfig,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      // zstd isn't in alpine:3 and is apk-installed at runtime, which needs
      // egress; gzip/none use busybox built-ins and stay network-isolated.
      NetworkDisabled: compression !== "zstd",
    });

    const stream = await helper.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });
    await helper.start();
    // Generous last-resort timeout so a genuinely stuck stream errors instead of
    // hanging forever (streamPath callers don't pass one).
    const timeoutMs = opts ? (opts as ExecuteCommandOpts).timeoutMs : undefined;
    return this.demuxContainerStream(helper, stream, timeoutMs ?? 60 * 60 * 1000);
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    // Restore path — re-uses the helper-container pattern but inverted:
    // stdin is the tar stream, the helper extracts into /mnt.
    const sources = await this.listSources(service);
    const source = sources.find((s) => s.id === targetSourceId);
    if (!source) {
      throw new Error(`Restore target "${targetSourceId}" not found on service ${service.name}`);
    }
    if (source.type === "tmpfs") {
      throw new Error(`Restore target "${targetSourceId}" is tmpfs — not restorable`);
    }

    const compression = opts?.compression ?? "zstd";
    const helperImage = compression === "zstd" ? "alpine:3" : HELPER_IMAGE;
    await this.ensureImage(helperImage);

    const clearCmd = opts?.clearTarget
      ? `find /mnt -mindepth 1 -delete 2>/dev/null || true; `
      : "";
    const untarCmd =
      compression === "zstd"
        ? `${clearCmd}zstd -d -c | tar -x -C /mnt`
        : `${clearCmd}tar -x${compressionFlag(compression)}f - -C /mnt`;

    const helper = await this.dockerode.createContainer({
      Image: helperImage,
      Cmd: [
        "sh",
        "-c",
        compression === "zstd"
          ? `apk add --no-cache zstd >/dev/null 2>&1; ${untarCmd}`
          : untarCmd,
      ],
      HostConfig: { Binds: [`${source.source}:/mnt`], AutoRemove: true },
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      // zstd isn't in alpine:3 and is apk-installed at runtime, which needs
      // egress; gzip/none use busybox built-ins and stay network-isolated.
      NetworkDisabled: compression !== "zstd",
    });

    const stream = await helper.attach({
      stream: true,
      hijack: true,
      stdin: true,
      stdout: true,
      stderr: true,
    });
    await helper.start();

    let bytesWritten = 0;
    body.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.byteLength;
    });
    // Capture the helper's own stdout/stderr (multiplexed) so a non-zero exit
    // reports WHY tar failed instead of a bare code.
    const errChunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => {
      if (errChunks.length < 32) errChunks.push(c);
    });
    body.pipe(stream);

    const waitResult = await helper.wait();
    if (waitResult.StatusCode !== 0) {
      const detail = Buffer.concat(errChunks)
        .toString("utf8")
        .replace(/[^\x20-\x7e\n]+/g, " ")
        .trim()
        .slice(-500);
      throw new Error(
        `Restore helper exited with code ${waitResult.StatusCode}${detail ? `: ${detail}` : ""}`,
      );
    }
    return { bytesWritten };
  }

  /**
   * SAME-DAEMON volume→volume copy in ONE helper container that mounts both
   * volumes — no SSH round-trip, no cross-connection stream, no compression.
   * The fastest path when source and target live on the same Docker daemon
   * (same-server migration copy). `tar | tar` preserves perms/owners/symlinks.
   *
   * Security: the volume names only reach dockerode's `Binds` (docker API, not
   * the shell) at FIXED mount points /from,/to — they never enter the `sh -c`
   * string, so there is no interpolation/injection surface. Helper is
   * network-isolated; source is mounted read-only.
   */
  async copyVolumeLocal(
    srcService: ServiceHandle,
    srcSourceId: string,
    dstService: ServiceHandle,
    dstSourceId: string,
    opts?: { clearTarget?: boolean },
  ): Promise<{ bytesWritten: number }> {
    const src = (await this.listSources(srcService)).find((s) => s.id === srcSourceId);
    const dst = (await this.listSources(dstService)).find((s) => s.id === dstSourceId);
    if (!src) throw new Error(`Copy source "${srcSourceId}" not found on ${srcService.name}`);
    if (!dst) throw new Error(`Copy target "${dstSourceId}" not found on ${dstService.name}`);
    if (src.type === "tmpfs" || dst.type === "tmpfs") {
      throw new Error(`Cannot copy tmpfs source (${srcSourceId}→${dstSourceId})`);
    }

    await this.ensureImage(HELPER_IMAGE);
    const clearCmd = opts?.clearTarget ? "find /to -mindepth 1 -delete 2>/dev/null || true; " : "";
    // Fixed mount points only — no untrusted value enters the shell string.
    //
    // A plain `tar … | tar …` exits with the RECEIVING tar's status under
    // POSIX sh, so a FAILED source read (perms, unreadable volume) still
    // reports success and silently leaves /to empty/partial — data loss. We
    // stash the source tar's exit code and require BOTH tars to succeed before
    // reporting size, so any read failure fails the copy loudly.
    const copyCmd =
      `${clearCmd}{ tar -C /from -cf - . ; echo $? > /tmp/src.rc ; } | tar -C /to -xf - ; ` +
      `rc=$? ; [ "$(cat /tmp/src.rc 2>/dev/null)" = 0 ] && [ "$rc" = 0 ] && du -sk /to 2>/dev/null | cut -f1`;
    const helper = await this.dockerode.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ["sh", "-c", copyCmd],
      HostConfig: {
        Binds: [`${src.source}:/from:ro`, `${dst.source}:/to`],
      },
      Tty: true, // merged raw stdout so the trailing `du` number reads cleanly
      NetworkDisabled: true,
    });
    try {
      await helper.start();
      const res = await helper.wait();
      const out = await helper
        .logs({ follow: false, stdout: true, stderr: true })
        .then((b) => b.toString().trim())
        .catch(() => "");
      if (res.StatusCode !== 0) {
        throw new Error(
          `Local volume copy failed (${srcSourceId}→${dstSourceId}): ${out.slice(0, 500) || `exit ${res.StatusCode}`}`,
        );
      }
      const kb = parseInt(out.split(/\s+/).pop() || "0", 10);
      return { bytesWritten: Number.isFinite(kb) ? kb * 1024 : 0 };
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  /**
   * Does the named volume behind `sourceId` already exist on this daemon, and
   * does it hold data? Used to refuse overwriting a pre-existing, non-empty
   * target volume. Fixed mount point (/probe) — no untrusted value hits the
   * shell. An unreadable/ambiguous result is reported as NON-empty (empty:false)
   * so we err on the side of NOT clobbering.
   */
  async probeVolume(
    service: ServiceHandle,
    sourceId: string,
  ): Promise<{ exists: boolean; empty: boolean }> {
    const source = (await this.listSources(service)).find((s) => s.id === sourceId);
    if (!source || source.type !== "volume" || !source.source) {
      return { exists: false, empty: true };
    }
    try {
      await this.dockerode.getVolume(source.source).inspect();
    } catch {
      return { exists: false, empty: true }; // not present → safe to create
    }
    await this.ensureImage(HELPER_IMAGE);
    const helper = await this.dockerode.createContainer({
      Image: HELPER_IMAGE,
      Cmd: [
        "sh",
        "-c",
        'if [ -z "$(ls -A /probe 2>/dev/null)" ]; then echo VOLEMPTY; else echo VOLDATA; fi',
      ],
      HostConfig: { Binds: [`${source.source}:/probe:ro`] },
      Tty: true,
      NetworkDisabled: true,
    });
    try {
      await helper.start();
      await helper.wait();
      const out = await helper
        .logs({ follow: false, stdout: true, stderr: true })
        .then((b) => b.toString())
        .catch(() => "");
      return { exists: true, empty: out.includes("VOLEMPTY") };
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  async pipeIntoCommand(
    service: ServiceHandle,
    cmd: string[],
    body: Readable,
    opts?: ExecuteCommandOpts,
  ): Promise<ExecExitInfo> {
    if (!service.containerId) {
      throw new Error(
        `Cannot exec in service ${service.name}: no containerId. Service must be deployed.`,
      );
    }
    const container = this.dockerode.getContainer(service.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      User: opts?.user,
      WorkingDir: opts?.cwd,
      Env: opts?.env
        ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: true });

    // Capture stderr while we write to stdin. dockerode demuxes the
    // hijacked stream — both stdout and stderr come back framed. We
    // collect a bounded tail for diagnostics; stdout is discarded
    // because restore commands typically log to stderr.
    const stderrChunks: Buffer[] = [];
    const { PassThrough } = await import("node:stream");
    const stdoutSink = new PassThrough();
    stdoutSink.resume();
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    this.dockerode.modem.demuxStream(
      stream as unknown as NodeJS.ReadableStream,
      stdoutSink,
      stderrSink,
    );

    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          try {
            (stream as unknown as { end?: () => void }).end?.();
          } catch {
            // best-effort
          }
        }, opts.timeoutMs)
      : null;

    return new Promise<ExecExitInfo>((resolve, reject) => {
      body.on("error", (err) => {
        if (timer) clearTimeout(timer);
        try {
          (stream as unknown as { end?: () => void }).end?.();
        } catch {
          // best-effort
        }
        reject(err);
      });
      stream.on("end", async () => {
        if (timer) clearTimeout(timer);
        try {
          const info = await this.dockerode.getExec(exec.id).inspect();
          resolve({
            code: info.ExitCode ?? 0,
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024),
          });
        } catch (err) {
          reject(err);
        }
      });
      stream.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      // Pipe body → stdin. ssh2/dockerode hijack streams are
      // bidirectional; writing to it = stdin, reading = stdout/stderr
      // (demuxed above).
      body.pipe(stream as unknown as NodeJS.WritableStream);
    });
  }

  async stopService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) return;
    try {
      await this.dockerode.getContainer(service.containerId).stop({ t: 30 });
    } catch {
      // Already stopped or gone — idempotent.
    }
  }

  async startService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) {
      throw new Error(`Cannot start service ${service.name}: no containerId`);
    }
    try {
      await this.dockerode.getContainer(service.containerId).start();
    } catch (err: unknown) {
      // Already running is fine.
      const e = err as { statusCode?: number };
      if (e?.statusCode !== 304) throw err;
    }
  }

  async isRunning(service: ServiceHandle): Promise<boolean> {
    if (!service.containerId) return false;
    try {
      const data = await this.dockerode.getContainer(service.containerId).inspect();
      return !!data.State?.Running;
    } catch {
      return false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async ensureImage(image: string): Promise<void> {
    // Single, shared pull path. Over SSH this runs a blocking `docker pull`
    // via the command executor — dockerode's pull + followProgress never EOFs
    // over the tunneled socket and hung the cross-server volume move.
    await this.runtime.pullImage(image);
  }

  /** dockerode `exec.start` returns a multiplexed stream — stdout +
   *  stderr interleaved with frame headers. demux into clean streams. */
  private attachDemuxed(
    docker: Dockerode,
    execId: string,
    stream: NodeJS.ReadWriteStream,
    timeoutMs: number | undefined,
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const stdout = new PassThrough();
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });

    docker.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderrSink);

    const awaitExit = new Promise<ExecExitInfo>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            stdout.destroy(new Error(`exec timed out after ${timeoutMs}ms`));
            reject(new Error(`exec timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      stream.on("end", async () => {
        if (timer) clearTimeout(timer);
        try {
          const info = await docker.getExec(execId).inspect();
          resolve({
            code: info.ExitCode ?? 0,
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024),
          });
        } catch (err) {
          reject(err);
        }
      });
      stream.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });

    return { stdout, awaitExit };
  }

  private demuxContainerStream(
    container: Dockerode.Container,
    stream: NodeJS.ReadWriteStream,
    timeoutMs: number | undefined,
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const stdout = new PassThrough();
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    container.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderrSink);
    // demuxStream never ends the destinations. End `stdout` when the attach
    // stream itself ends (all output demuxed) — otherwise a consumer piping it
    // into `tar -x` stdin never sees EOF and hangs. This is RELIABLE only
    // because the helper has no AutoRemove (see streamPath): docker flushes the
    // output then closes the attach cleanly on exit. We must NOT end on
    // container.wait() — the container can exit while bytes are still buffered,
    // and ending early truncates the tar ("Restore helper exited 1").
    //
    const endSinks = () => {
      stdout.end();
      stderrSink.end();
    };
    stream.on("end", endSinks);
    stream.on("close", endSinks);

    const awaitExit = new Promise<ExecExitInfo>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            stdout.destroy(new Error(`helper container timed out after ${timeoutMs}ms`));
            reject(new Error(`helper container timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      container
        .wait()
        .then((res) => {
          if (timer) clearTimeout(timer);
          // Backstop: over the SSH-tunneled attach the stream's end/close is not
          // always delivered. The container has exited so all output is pushed;
          // give the buffer a moment to drain, then force-close. Idempotent.
          setTimeout(endSinks, 3000);
          resolve({
            code: res.StatusCode,
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024),
          });
        })
        .catch((err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        });
    });

    return { stdout, awaitExit };
  }
}

// ─── Self-registration ───────────────────────────────────────────────────────

registerExecutor("docker", (runtime) => {
  if (!(runtime instanceof DockerRuntime)) {
    throw new Error(
      "DockerBackupExecutor requires a DockerRuntime instance. " +
        `Got: ${(runtime as { name?: string })?.name ?? typeof runtime}`,
    );
  }
  return new DockerBackupExecutor(runtime);
});
