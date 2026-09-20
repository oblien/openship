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
import { safeErrorMessage, withTimeout, shellQuote } from "@repo/core";
import { DockerRuntime, resolveExecExitCode } from "../../runtime/docker";
import { demuxDockerStream } from "../../runtime/docker-demux";
import {
  daemonConnectionFrom,
  startAttachStream,
  startExecStream,
} from "../../runtime/docker-exec-stream";
import { ensureScopedVolumeName, isHostPathSource } from "../../runtime/volume-namespace";
import { safeDumpCommand, safeRestoreCommand, type DumpCodec } from "../common/dump-pipeline";
import { matchBackupSource } from "../common/source-match";
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
const BIND_PROBE_TARGET = "/__openship_bind_source";

/** Docker's archive stat header encodes Go's os.FileMode; its top bit is ModeDir. */
const DOCKER_MODE_DIRECTORY = 2 ** 31;

type ArchiveInfoResponse = {
  headers?: Record<string, string | string[] | undefined>;
  resume?: () => unknown;
};

/**
 * How many artifact bytes may sit between the daemon and OUR writer.
 *
 * A real ceiling rather than a hint: `demuxDockerStream` pauses the attach socket
 * whenever this PassThrough is full, so a destination that drains slower than the dump is
 * produced makes the backup slow instead of killing the API (#633). Bigger than the 16 KB
 * stream default so a fast producer isn't paused and resumed thousands of times per
 * second.
 *
 * NOT the whole in-flight figure, and an earlier version of this comment wrongly claimed
 * it was "the ONLY place the payload is allowed to accumulate". The destination has its
 * own buffer downstream of this one — for S3 the SDK's `Upload` holds up to
 * `partSize × queueSize` (see MULTIPART_* in destinations/s3.ts) — so per run the honest
 * number is this 4 MB PLUS whatever the destination holds, and the total scales with job
 * concurrency. Stated precisely because "bounded" was the whole claim of the #633 fix, and
 * a bound quoted 17× too low is the kind of comment that gets trusted in the wrong
 * direction later.
 */
const ARTIFACT_BUFFER_BYTES = 4 * 1024 * 1024;

/** No traffic for this long in EITHER direction = wedged. See
 *  ReceiveStreamOpts.idleTimeoutMs for why idle and not wall-clock. Capture and
 *  restore share these on purpose: a wall-clock bound that a 50GB restore is
 *  allowed to blow through cannot be right for the backup that produced it. */
const DEFAULT_HELPER_IDLE_MS = 10 * 60 * 1000;
/** Last-resort ceiling behind the idle watchdog. Long enough that no honest
 *  transfer hits it, short enough that a stuck one is not forever. */
const DEFAULT_HELPER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** How often to ask the daemon directly whether the helper has exited. */
const EXIT_POLL_INTERVAL_MS = 2000;
/**
 * Quiet window the lost-`end` backstop needs before it force-closes the sinks.
 *
 * Re-checked rather than fired once: the helper can exit with its tail still in the
 * socket, and closing then truncates the archive silently. See demuxContainerStream.
 */
const ATTACH_DRAIN_QUIET_MS = 3000;

/**
 * A timer that fires only after `ms` of silence, reset by `touch()`.
 *
 * The promise rejects; it is meant to be raced. `dispose()` after the race so a
 * pending timer can't fire against a finished operation. Timers are unref'd — a
 * watchdog should never be the reason a process stays alive.
 */
function createIdleWatchdog(
  ms: number,
  message: string,
): { touch: () => void; promise: Promise<never>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let fire: (err: Error) => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    fire = reject;
  });
  const arm = () => {
    timer = setTimeout(() => {
      done = true;
      fire(new Error(message));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  return {
    touch: () => {
      if (done) return;
      if (timer) clearTimeout(timer);
      arm();
    },
    promise,
    dispose: () => {
      done = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * A rejection that lands when `signal` aborts, shaped like the idle watchdog so
 * it can join the same race. `dispose` removes the listener — without it a
 * long-lived controller (one restore's signal, many artifacts) accumulates one
 * listener per artifact and warns at ten.
 */
function createAbortWatch(
  signal: AbortSignal,
  message: string,
): { promise: Promise<never>; dispose: () => void } {
  let fire: (err: Error) => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    fire = reject;
  });
  const onAbort = () => fire(new Error(message));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/** Destroy a stream without caring whether it was already gone. */
function destroyQuietly(stream: { destroy?: (err?: Error) => void } | undefined): void {
  try {
    stream?.destroy?.();
  } catch {
    // best-effort teardown
  }
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
function parseVolumeSpec(
  spec: string,
): { source: string; target: string; type: BackupSource["type"] } | null {
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

/** Read the path type returned by Docker's HEAD /containers/:id/archive endpoint. */
function archivePathIsDirectory(response: ArchiveInfoResponse, path: string): boolean {
  const rawHeader = response.headers?.["x-docker-container-path-stat"];
  const encoded = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!encoded) {
    throw new Error(`Docker returned no path-stat header while inspecting ${path}`);
  }

  let stat: unknown;
  try {
    stat = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (err) {
    throw new Error(`Docker returned an invalid path-stat header while inspecting ${path}`, {
      cause: err,
    });
  }
  const mode = (stat as { mode?: unknown } | null)?.mode;
  if (typeof mode !== "number" || !Number.isSafeInteger(mode)) {
    throw new Error(`Docker returned no valid path mode while inspecting ${path}`);
  }
  return mode >= DOCKER_MODE_DIRECTORY;
}

function isMissingBindSourceError(err: unknown): boolean {
  return (
    (err as { statusCode?: number } | null)?.statusCode === 400 &&
    /bind source path does not exist/i.test(safeErrorMessage(err))
  );
}

export class DockerBackupExecutor implements BackupExecutor {
  readonly runtimeName = "docker" as const;

  constructor(private readonly runtime: DockerRuntime) {}

  private get dockerode(): Dockerode {
    return this.runtime.docker;
  }

  /**
   * Freeze / thaw the target container around a copy — Docker's native cgroup freezer.
   *
   * `unpause` is best-effort and deliberately swallows "not paused": the thaw runs from a
   * `finally`, and a container the daemon already restarted (or that a human unpaused)
   * must not turn a completed backup into a failed one. `pause` is NOT best-effort — see
   * streamPath.
   */
  private async freeze(containerId: string): Promise<void> {
    await this.dockerode.getContainer(containerId).pause();
  }

  private async thaw(containerId: string, label: string): Promise<void> {
    try {
      await this.dockerode.getContainer(containerId).unpause();
    } catch (err) {
      // Loud, because a container left frozen is an outage. Not fatal, because the
      // artifact is already whole and failing the run would not thaw anything.
      console.error(
        `[backup] ${label}: could not unpause container ${containerId.slice(0, 12)} after the ` +
          `copy — the service may still be FROZEN and needs \`docker unpause\`: ` +
          `${(err as { message?: string })?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Ask the Docker daemon about a path in a container's mount namespace.
   *
   * The API may itself run in a container or connect to Docker over SSH/TLS, so
   * `node:fs` would inspect the wrong filesystem. Docker's archive-info endpoint
   * returns the daemon-side path's Go FileMode without copying any archive bytes.
   */
  private async containerPathIsDirectory(
    container: Dockerode.Container,
    path: string,
  ): Promise<boolean> {
    let response: ArchiveInfoResponse | undefined;
    try {
      response = (await container.infoArchive({ path })) as ArchiveInfoResponse;
      return archivePathIsDirectory(response, path);
    } finally {
      // dockerode exposes the HEAD response as a stream. Drain it so the daemon
      // connection can be reused, including through the SSH/TLS transports.
      response?.resume?.();
    }
  }

  /**
   * Classify a recorded bind source when there is no service container to inspect.
   * A never-started helper gives Docker a mount namespace, and archive-info reports
   * the source type from the daemon host. `Mounts` (rather than legacy `Binds`) is
   * deliberate: a missing source is rejected instead of being created as a directory.
   */
  private async declaredBindIsDirectory(sourcePath: string): Promise<boolean> {
    try {
      return await this.withHelper(
        {
          Image: HELPER_IMAGE,
          NetworkDisabled: true,
          HostConfig: {
            Mounts: [
              {
                Type: "bind",
                Source: sourcePath,
                Target: BIND_PROBE_TARGET,
                ReadOnly: true,
              },
            ],
          },
        },
        (helper) => this.containerPathIsDirectory(helper, BIND_PROBE_TARGET),
      );
    } catch (err) {
      // Preserve the existing restore behavior for a declared directory that does
      // not exist yet: streamPath/receiveStream may create and populate it later.
      if (isMissingBindSourceError(err)) return true;
      throw new Error(
        `Could not inspect bind mount source "${sourcePath}" on the Docker host: ` +
          safeErrorMessage(err),
        { cause: err },
      );
    }
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    // Two sources of truth:
    //  1. Live container's actual Mounts (authoritative when the
    //     service is deployed). Captures Docker's resolution of relative
    //     paths and named-volume namespacing.
    //  2. service.volumes from the DB (fallback when the container
    //     isn't running or doesn't exist yet).
    if (service.containerId) {
      const container = this.dockerode.getContainer(service.containerId);
      let data: Awaited<ReturnType<typeof container.inspect>> | null = null;
      try {
        data = await container.inspect();
      } catch {
        // Container gone — fall through to the DB-declared volumes.
      }
      if (data) {
        const mounts = (data.Mounts ?? []) as Array<{
          Type?: string;
          Name?: string;
          Source?: string;
          Destination?: string;
        }>;
        const sources: BackupSource[] = [];
        for (const [i, mount] of mounts.entries()) {
          if (mount.Type !== "volume" && mount.Type !== "bind") continue;
          if (
            mount.Type === "bind" &&
            (!mount.Destination ||
              !(await this.containerPathIsDirectory(container, mount.Destination)))
          ) {
            continue;
          }
          sources.push({
            id: mount.Name ?? mount.Source ?? `mount-${i}`,
            target: mount.Destination ?? "",
            source: mount.Name ?? mount.Source ?? "",
            type: mount.Type,
          });
        }
        return sources;
      }
    }

    const sources = service.volumes
      .map((spec, i): BackupSource | null => {
        const parsed = parseVolumeSpec(spec);
        if (!parsed || !parsed.source) return null;
        // Named volumes are project-scoped at deploy time; resolve the SAME
        // name here so the fallback mounts the real volume (not an empty one
        // docker would auto-create). Bind mounts and grandfathered services
        // (namespaceVolumes=false) keep the raw source.
        //
        // Idempotent on purpose: the column stores whatever was written at deploy
        // time, and for services deployed from an already-scoped spec that is the
        // SCOPED name. Prefixing twice named a volume that never existed, which docker
        // creates empty on mount — a capture that archives nothing (now a failure
        // rather than a green run, via the empty-source gate) and a restore into a
        // volume nothing reads.
        const source =
          parsed.type === "volume" && service.namespaceVolumes
            ? ensureScopedVolumeName(service.projectSlug, parsed.source)
            : parsed.source;
        return {
          id: `${source}-${i}`,
          source,
          target: parsed.target,
          type: parsed.type,
        };
      })
      .filter((x): x is BackupSource => x !== null);

    if (!sources.some((source) => source.type === "bind")) return sources;
    await this.ensureImage(HELPER_IMAGE);

    const backupable: BackupSource[] = [];
    for (const source of sources) {
      if (source.type !== "bind" || (await this.declaredBindIsDirectory(source.source))) {
        backupable.push(source);
      }
    }
    return backupable;
  }

  /**
   * The container's own `Config.Env`, as `KEY=value` pairs already split.
   *
   * This is the credentials source for every service Openship did not deploy
   * itself — see `BackupExecutor.readContainerEnv`. Returns `{}` rather than
   * throwing on any failure: it is an ENRICHMENT of the handle's env, so a
   * container that has gone away, or a daemon that refuses the inspect, must leave
   * the caller exactly as well off as before it asked.
   */
  async readContainerEnv(service: ServiceHandle): Promise<Record<string, string>> {
    if (!service.containerId) return {};
    try {
      const data = await this.dockerode.getContainer(service.containerId).inspect();
      const pairs = ((data.Config?.Env ?? []) as string[]) ?? [];
      const env: Record<string, string> = {};
      for (const pair of pairs) {
        // Split on the FIRST `=` only: a value may contain them (a DSN, a JWT), and
        // splitting on every one would truncate exactly the secrets that matter.
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return env;
    } catch {
      return {};
    }
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
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    // Read the dump over a RAW SOCKET, not through docker-modem. Neither of modem's
    // two options can carry a backup.
    //
    // `{hijack: true}` makes it ask for a connection upgrade, and under Bun (this api
    // ships as a Bun image and a Bun-compiled desktop binary) node:http surfaces the
    // daemon's `101 Switching Protocols` as a plain `response`, so modem rejected
    // every exec with `(HTTP code 101) unexpected` before a byte was read.
    //
    // Without hijack it hands back the `http.IncomingMessage` instead — which starts
    // flowing and, under Bun, CANNOT BE STOPPED. Measured on Bun 1.3.1 vs Node 22,
    // one 64 KB-chunk producer against a client that reads a single chunk and then
    // pauses: Node's peer blocks after ~0.9 MB, Bun's swallows the ENTIRE 2 GB stream
    // into its own buffers while the consumer has seen 0.1 MB. On a raw net.Socket
    // Bun stops at ~1.6 MB, like Node.
    //
    // So `demuxDockerStream`'s backpressure — the whole #633 fix — is a no-op here
    // unless the thing it pauses is a socket we own. This is the single entry point
    // for EVERY producer (pg_dump, mysqldump, mongodump, redis, custom commands,
    // pre/post hooks), i.e. precisely the path that OOM'd on a 110 GB dump, so it uses
    // the same hand-rolled upgrade the restore direction already relies on. Nothing
    // here writes stdin; `stdin: false` keeps the channel read-only.
    const stream = await startExecStream(daemonConnectionFrom(this.dockerode), exec.id, {
      tty: false,
      stdin: false,
    });
    return this.attachDemuxed(this.dockerode, exec.id, stream, opts, {
      label: `exec in service ${service.name}`,
    });
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    const sources = await this.listSources(service);
    const source = matchBackupSource(sources, sourceId);
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
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => ["--exclude", shellQuote(p)]);
    const tarFlags = compressionFlag(compression);
    const tarCmd = `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} .`;
    const helperImage = compression === "zstd" ? "alpine:3" : HELPER_IMAGE;

    await this.ensureImage(helperImage);

    const hostConfig: Dockerode.HostConfig = {
      Binds: [`${source.source}:/mnt:ro`],
      // OFF, for the reason demuxContainerStream already documents but this line
      // used to contradict: AutoRemove lets the daemon reap the helper before
      // container.wait() answers and before the attach stream has drained, which
      // is a 404 on the exit status or a truncated tar. demuxContainerStream
      // removes it once the archive is fully demuxed.
      AutoRemove: false,
      // The archive streams over `attach()` below — the daemon's default
      // json-file driver would ALSO write every byte of it to
      // /var/lib/docker/containers as a log. That's a second copy of the whole
      // backup, and worse than a copy: json-file escapes binary, so a 4.6 GB
      // volume ballooned to a 12 GB log file here. Backups then spike the
      // host's disk by more than the data they read and only release it when
      // the helper exits. Nothing ever reads these logs.
      LogConfig: { Type: "none", Config: {} },
    };

    // Quiesce, if asked. The freeze must cover the ENTIRE copy, and the copy outlives this
    // function — `handOffHelper` returns a stream the caller drains — so the thaw is tied
    // to `awaitExit` settling, not to this call returning.
    //
    // `pause` is deliberately NOT best-effort: the caller asked for a point-in-time
    // archive, and quietly producing a crash-consistent one labelled as quiesced is the
    // silent-downgrade pattern this module exists to remove.
    const quiesceId = opts?.quiesce ? service.containerId : null;
    if (opts?.quiesce && !quiesceId) {
      throw new Error(
        `Cannot quiesce service "${service.name}" for a consistent copy: it has no running ` +
          `container to freeze. Either deploy it, or take the copy without quiesce and accept ` +
          `a crash-consistent archive.`,
      );
    }
    if (quiesceId) await this.freeze(quiesceId);

    const handed = await this.handOffHelper(
      {
        Image: helperImage,
        // Built by the SAME helper the DB producers use, for the same reason: a shell
        // pipeline exits with its LAST command's status, so `tar -c … | zstd` reported
        // ZSTD's success and a tar that failed mid-archive — a permissions error, a
        // vanishing file, ENOSPC in the pipe — came back as exit 0 over a truncated
        // archive that the run then recorded as a complete backup. Closing that for
        // `pg_dump | zstd` and leaving it here would have been the same bug with a
        // different payload, and the volume producer is the DEFAULT one.
        //
        // gzip and none need no pipeline at all (busybox tar compresses in-process via
        // `tarFlags`), so those pass `"none"` and keep tar's own status directly.
        Cmd: safeDumpCommand(
          tarCmd,
          compression === "zstd" ? "zstd" : "none",
          [
            // REFUSE an empty mount before doing anything else.
            //
            // The daemon CREATES a missing bind directory and a missing named volume
            // when it honors HostConfig.Binds, so a source that is not on this host
            // produces a helper that starts fine and a `tar -c` of nothing that exits
            // 0. That archive is ~350 bytes compressed, so the orchestrator's
            // zero-byte guard passes and the run is recorded as a successful backup —
            // a nightly green tick over an external disk that failed to mount, a data
            // directory that was renamed under a still-running container, or a volume
            // that `docker system prune --volumes` took.
            //
            // An intentionally-empty source fails too, which is the deliberate half of
            // the trade: an archive of nothing is not a restore point either way, and
            // the operator has `payloadConfig.sourceIds` to narrow the policy. Silence
            // is the only outcome that cannot be recovered from.
            `SRC=${shellQuote(sourceId)}`,
            `[ -n "$(ls -A /mnt 2>/dev/null)" ] || { echo "openship: backup source $SRC is ` +
              `empty or missing on this host, so this archive would contain nothing. ` +
              `Refusing to record it as a backup. If it is a mount, check that it is ` +
              `mounted; if it is empty on purpose, narrow the policy's sourceIds." >&2; ` +
              `exit 91; }`,
            // zstd is not in alpine:3, so the helper installs it. Second, so a doomed
            // capture does not pay the ~20s fetch first.
            compression === "zstd" ? "apk add --no-cache zstd >/dev/null 2>&1" : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        HostConfig: hostConfig,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        // zstd isn't in alpine:3 and is apk-installed at runtime, which needs
        // egress; gzip/none use busybox built-ins and stay network-isolated.
        NetworkDisabled: compression !== "zstd",
      },
      async (helper) => {
        // Raw socket, not `helper.attach()`, for the reason execStream documents at
        // length: dockerode's non-hijack attach yields an `http.IncomingMessage`, and
        // under Bun pausing one does not stop the daemon — it buffers the whole
        // archive internally instead. A volume tar is the other unbounded payload in
        // this file, so it needs the same transport to be genuinely bounded.
        const stream = await startAttachStream(daemonConnectionFrom(this.dockerode), helper.id, {
          stdin: false,
          stdout: true,
          stderr: true,
        });
        await helper.start();
        return this.demuxContainerStream(helper, stream, {
          idleTimeoutMs: opts?.idleTimeoutMs ?? DEFAULT_HELPER_IDLE_MS,
          timeoutMs: opts?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
          label: `Backup of "${sourceId}" on service ${service.name}`,
        });
      },
    ).catch(async (err) => {
      // The hand-off itself failed, so nothing will settle `awaitExit` and thaw below.
      if (quiesceId) await this.thaw(quiesceId, `backup of "${sourceId}"`);
      throw err;
    });

    if (!quiesceId) return handed;
    return {
      stdout: handed.stdout,
      // Thaw when the copy is DONE, however it ends. `awaitExit` settles once the helper
      // has exited and its output has drained, which is precisely the window the freeze has
      // to cover; unfreezing when `streamPath` returned would thaw before a single byte had
      // been read. The original promise is handed back so a caller still sees its value or
      // its rejection.
      awaitExit: handed.awaitExit.finally(() =>
        this.thaw(quiesceId, `backup of "${sourceId}"`),
      ),
    };
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    // Restore path — re-uses the helper-container pattern but inverted:
    // stdin is the tar stream, the helper extracts into /mnt.
    // Checked before anything is created: past helper.start() the target is
    // already being cleared, so this is the last free place to bail.
    opts?.signal?.throwIfAborted();
    const sources = await this.listSources(service);
    const source = matchBackupSource(sources, targetSourceId);
    if (!source) {
      throw new Error(`Restore target "${targetSourceId}" not found on service ${service.name}`);
    }
    if (source.type === "tmpfs") {
      throw new Error(`Restore target "${targetSourceId}" is tmpfs — not restorable`);
    }

    const compression = opts?.compression ?? "zstd";
    const helperImage = compression === "zstd" ? "alpine:3" : HELPER_IMAGE;
    await this.ensureImage(helperImage);

    // ORDER IS THE FIX HERE, and it is the difference between a failed restore and
    // destroyed data.
    //
    // This used to be `apk add --no-cache zstd >/dev/null 2>&1; find /mnt -delete; zstd
    // -d -c | tar -x`. Three defects compounding:
    //   1. `apk add` joined with `;`, output discarded — a host with no egress (and
    //      egress is required only on this codec, hence `NetworkDisabled` below) simply
    //      has no zstd.
    //   2. The target was CLEARED before anything checked that the decompressor exists.
    //   3. The pipeline reports tar's status, and `tar -x` reading EOF exits 0.
    // Verified locally: `sh -c 'find out -delete; nonexistent_zstd -d -c | tar -x -C out'`
    // exits 0 with `out/` emptied. So a volume restore wiped the volume, extracted
    // nothing, returned success — and `receiveStream` counts `bytesWritten` off `body`,
    // not off tar, so the caller saw a healthy byte count. Upstream, the restore's own
    // hasher never completes, and `digestIfComplete` treats that as "unverifiable, not a
    // mismatch" (right in general), so nothing objected and the run went `succeeded`.
    //
    // Strictly worse than #611: that one failed to take a backup, this one deletes your
    // data and reports a green restore.
    //
    // Now: install, PROVE the tool is there, and only then destroy anything — and the
    // pipeline goes through `safeRestoreCommand`, so the decompressor's status can no
    // longer hide behind tar's.
    const restoreCodec: DumpCodec = compression === "none" ? "none" : compression;
    const prelude = [
      compression === "zstd" ? "apk add --no-cache zstd >/dev/null 2>&1 || true" : null,
      compression === "zstd"
        ? 'command -v zstd >/dev/null 2>&1 || { echo "openship: zstd is not available in the ' +
          'restore helper and could not be installed (the host may have no egress). ' +
          'Refusing to clear the target: nothing was written and your data is untouched." >&2; ' +
          "exit 90; }"
        : null,
      compression === "gzip"
        ? 'command -v gzip >/dev/null 2>&1 || { echo "openship: gzip is not available in the ' +
          'restore helper. Refusing to clear the target; your data is untouched." >&2; exit 90; }'
        : null,
      // Only now, with every tool proven present.
      opts?.clearTarget ? "find /mnt -mindepth 1 -delete 2>/dev/null || true" : null,
    ]
      .filter(Boolean)
      .join("\n");

    return this.withHelper(
      {
        Image: helperImage,
        Cmd: safeRestoreCommand(restoreCodec, "tar -x -C /mnt", prelude),
        // AutoRemove is OFF deliberately, and this is the fix for the `404 no such
        // container` in #434: with it on, the daemon could reap the helper before
        // /containers/{id}/wait answered, and the exit status was then unknowable.
        // withHelper reaps instead — which also plugs a leak AutoRemove never
        // covered, since it only fires for a container that actually started.
        HostConfig: { Binds: [`${source.source}:/mnt`], AutoRemove: false },
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: true,
        StdinOnce: true,
        Tty: false,
        // zstd isn't in alpine:3 and is apk-installed at runtime, which needs
        // egress; gzip/none use busybox built-ins and stay network-isolated.
        NetworkDisabled: compression !== "zstd",
      },
      async (helper) => {
        let stream: Awaited<ReturnType<typeof startAttachStream>> | undefined;
        const idleMs = opts?.idleTimeoutMs ?? DEFAULT_HELPER_IDLE_MS;
        const watchdog = createIdleWatchdog(
          idleMs,
          `Restore of "${targetSourceId}" on service ${service.name} moved no data for ` +
            `${Math.round(idleMs / 1000)}s and was abandoned. The extract helper has been ` +
            `removed; the target may hold partial data.`,
        );
        const abortWatch = opts?.signal
          ? createAbortWatch(
              opts.signal,
              `Restore of "${targetSourceId}" on service ${service.name} was cancelled ` +
                `mid-extract. The target holds partial data.`,
            )
          : undefined;

        try {
          // Hand-rolled upgrade instead of dockerode's `attach({hijack:true})`: this
          // attach exists to WRITE the archive to the helper's stdin, and dockerode has
          // no other stdin-capable path. Under Bun its hijack resolves through modem's
          // `response` branch as `(HTTP code 101) unexpected` rather than handing back
          // the socket, so no restore could ever write a byte. Same protocol, plain
          // socket — see docker-exec-stream.ts.
          stream = await startAttachStream(daemonConnectionFrom(this.dockerode), helper.id, {
            stdin: true,
            stdout: true,
            stderr: true,
          });
          await helper.start();

          let bytesWritten = 0;
          let bodyEnded = false;
          body.on("data", (chunk: Buffer) => {
            bytesWritten += chunk.byteLength;
            watchdog.touch();
          });
          // Capture the helper's own stdout/stderr (multiplexed) so a non-zero exit
          // reports WHY tar failed instead of a bare code.
          const errChunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => {
            watchdog.touch();
            if (errChunks.length < 32) errChunks.push(c);
          });
          body.on("end", () => {
            bodyEnded = true;
            watchdog.touch();
          });
          body.pipe(stream);

          const waitResult = await this.awaitHelperExit(helper, watchdog, () => bodyEnded, {
            timeoutMs: opts?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
            label: `Restore of "${targetSourceId}" on service ${service.name}`,
            note: "The target may hold partial data.",
            cancelled: abortWatch?.promise,
          });
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
        } finally {
          watchdog.dispose();
          abortWatch?.dispose();
          // Order matters: drop the sockets before withHelper removes the
          // container, so a force-remove can't race a still-open attach. Unlike
          // streamPath there is nothing left to drain here — the bytes flowed
          // INTO the helper, and by this point we have its exit status.
          destroyQuietly(stream);
          destroyQuietly(body);
        }
      },
    );
  }

  /**
   * Create a helper, run `fn`, reap the helper however `fn` ends.
   *
   * Every helper here is disposable and every one of them must be removed by us:
   * `AutoRemove` is off on purpose (it races /wait, and it only ever fires for a
   * container that actually started, so a throw between create and start leaked
   * one permanently — the leak behind #434). Four call sites each had their own
   * correct copy of that reap, which is exactly how one of them came to be the
   * one that didn't.
   *
   * NOT for helpers whose output outlives the call: streamPath hands its
   * container to demuxContainerStream, which must reap only after the archive
   * has drained. `handOffHelper` covers that shape.
   */
  private async withHelper<T>(
    spec: Dockerode.ContainerCreateOptions,
    fn: (helper: Dockerode.Container) => Promise<T>,
  ): Promise<T> {
    const helper = await this.dockerode.createContainer(spec);
    try {
      return await fn(helper);
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  /**
   * Create a helper whose lifetime outlives this call: reap it only if `setup`
   * throws, then hand ownership to whatever `setup` returned. Without this, a
   * failure between createContainer and the hand-off leaks the container
   * forever — nothing downstream knows it exists yet.
   */
  private async handOffHelper<T>(
    spec: Dockerode.ContainerCreateOptions,
    setup: (helper: Dockerode.Container) => Promise<T>,
  ): Promise<T> {
    const helper = await this.dockerode.createContainer(spec);
    try {
      return await setup(helper);
    } catch (err) {
      await helper.remove({ force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Wait for a helper to exit without trusting any single signal.
   *
   * `helper.wait()` alone is what hung in #434: /containers/{id}/wait is a
   * long-poll with no timeout on either the modem or our transport, so a lost
   * response is indistinguishable from a running container — forever. Three
   * backstops race it:
   *
   *   1. An exit poll that asks the daemon directly. This is what turns the
   *      common hang into a few seconds. It's the same "don't trust the attach
   *      stream's terminal signal" reasoning already documented in
   *      demuxContainerStream; receiveStream was the path without a backstop.
   *   2. The caller's idle watchdog (fed by real traffic, not by this function).
   *   3. An absolute ceiling, so even a helper that somehow keeps trickling
   *      bytes cannot run unbounded.
   *
   * The poll only starts once the body has been fully written: before that a
   * not-yet-running helper is normal, and inspecting on a loop would be noise.
   * It is gated on the body rather than on the attach stream closing because
   * over an SSH-tunneled attach that close is not reliably delivered — the very
   * reason this backstop has to exist.
   */
  private async awaitHelperExit(
    helper: Dockerode.Container,
    watchdog: { promise: Promise<never> },
    bodyEnded: () => boolean,
    opts: { timeoutMs: number; label: string; note?: string; cancelled?: Promise<never> },
  ): Promise<{ StatusCode: number }> {
    let polling = true;
    const pollExit = async (): Promise<{ StatusCode: number }> => {
      while (polling) {
        await new Promise((r) => {
          const t = setTimeout(r, EXIT_POLL_INTERVAL_MS);
          (t as { unref?: () => void }).unref?.();
        });
        if (!polling || !bodyEnded()) continue;
        let state: { Running?: boolean; Status?: string; ExitCode?: number };
        try {
          state = (await helper.inspect()).State ?? {};
        } catch (err) {
          // With AutoRemove off, a vanished helper means something outside this
          // call removed it — we can never learn its exit code, so say that
          // rather than reporting a success we didn't observe.
          if ((err as { statusCode?: number })?.statusCode === 404) {
            throw new Error(
              `${opts.label}: the helper disappeared before its exit status could be ` +
                `read.${opts.note ? ` ${opts.note}` : ""}`,
            );
          }
          continue; // transient daemon hiccup — keep polling
        }
        // "created" also reports Running:false; only an exit carries a code.
        if (
          state.Running === false &&
          state.Status !== "created" &&
          typeof state.ExitCode === "number"
        ) {
          return { StatusCode: state.ExitCode };
        }
      }
      // Only reachable once the race has already settled and the finally below
      // cleared the flag; never resolving is correct, nobody is listening.
      return new Promise<never>(() => {});
    };

    try {
      return await withTimeout(
        Promise.race([
          helper.wait() as Promise<{ StatusCode: number }>,
          pollExit(),
          watchdog.promise,
          ...(opts.cancelled ? [opts.cancelled] : []),
        ]),
        opts.timeoutMs,
        `${opts.label} exceeded its ${Math.round(opts.timeoutMs / 1000)}s ceiling and was ` +
          `abandoned.${opts.note ? ` ${opts.note}` : ""}`,
      );
    } finally {
      polling = false;
    }
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
    const src = matchBackupSource(await this.listSources(srcService), srcSourceId);
    const dst = matchBackupSource(await this.listSources(dstService), dstSourceId);
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
    return this.withHelper(
      {
        Image: HELPER_IMAGE,
        Cmd: ["sh", "-c", copyCmd],
        HostConfig: {
          Binds: [`${src.source}:/from:ro`, `${dst.source}:/to`],
        },
        Tty: true, // merged raw stdout so the trailing `du` number reads cleanly
        NetworkDisabled: true,
      },
      async (helper) => {
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
      },
    );
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
    const source = matchBackupSource(await this.listSources(service), sourceId);
    if (!source || source.type !== "volume" || !source.source) {
      return { exists: false, empty: true };
    }
    try {
      await this.dockerode.getVolume(source.source).inspect();
    } catch {
      return { exists: false, empty: true }; // not present → safe to create
    }
    await this.ensureImage(HELPER_IMAGE);
    return this.withHelper(
      {
        Image: HELPER_IMAGE,
        Cmd: [
          "sh",
          "-c",
          'if [ -z "$(ls -A /probe 2>/dev/null)" ]; then echo VOLEMPTY; else echo VOLDATA; fi',
        ],
        HostConfig: { Binds: [`${source.source}:/probe:ro`] },
        Tty: true,
        NetworkDisabled: true,
      },
      async (helper) => {
        await helper.start();
        await helper.wait();
        const out = await helper
          .logs({ follow: false, stdout: true, stderr: true })
          .then((b) => b.toString())
          .catch(() => "");
        return { exists: true, empty: out.includes("VOLEMPTY") };
      },
    );
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
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    // Hand-rolled upgrade rather than dockerode's `{hijack: true}`: this exec
    // needs stdin (the dump bytes), and under Bun modem's hijack comes back as
    // `(HTTP code 101) unexpected` instead of the socket, so every DB restore
    // failed before writing a byte. Tty stays false so output is still framed.
    const stream = await startExecStream(daemonConnectionFrom(this.dockerode), exec.id, {
      tty: false,
      stdin: true,
    });

    // Capture stderr while we write to stdin — both streams come back
    // multiplexed. We collect a bounded tail for diagnostics; stdout is discarded
    // because restore commands typically log to stderr.
    const stderrChunks: Buffer[] = [];
    const { PassThrough } = await import("node:stream");
    const stdoutSink = new PassThrough();
    stdoutSink.resume();
    // MANDATORY, not defensive, and it is new with `demuxDockerStream`.
    //
    // `modem.demuxStream` only ever WROTE to its sinks; ours destroys `stdout` with an
    // Error on every abnormal end — a source error, a desync, an end mid-frame. An
    // `'error'` event on a stream with no listener is an uncaught exception, and there
    // is no `uncaughtException` handler in this process, so the API DIES — taking every
    // other in-flight backup, restore and deployment with it, and stranding the restore
    // row instead of recording it failed.
    //
    // Reachable on every restore: when the loader exits early (wrong credentials under
    // `ON_ERROR_STOP=1`) the daemon closes the hijacked socket while `body.pipe(stream)`
    // is still writing, the next write yields EPIPE, and `bridgeSocket` turns that into
    // an `'error'` on this duplex. The timeout path reaches the same place.
    //
    // Swallowing is right HERE specifically: this sink's bytes are discarded by
    // contract (restore commands log to stderr), the payload travels the OTHER way — in
    // through stdin — so a demux failure on the output side cannot corrupt what is
    // being restored, and the real failure already reaches the caller through the
    // `stream.on("error")` → reject below.
    stdoutSink.on("error", () => {});
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    demuxDockerStream(stream as unknown as NodeJS.ReadableStream, stdoutSink, stderrSink);

    const stderrTail = () =>
      Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024);

    // Every LOGICAL restore applies through here — pg_restore, mysql, mongorestore,
    // redis, custom_command — and this was the one direction with no completion
    // backstop. The old ceiling only closed stdin and then kept waiting, which a
    // `pg_restore` blocked on a lock ignores: nothing ever settled, the restore row sat
    // in `applying` until a stale sweep guessed at it, and the exec was never reaped.
    //
    // So the same pair `streamPath`/`receiveStream` already share:
    //   • the exec's own status, polled once the body is fully written, for the case
    //     where the hijacked socket never EOFs (the #516 shape, one direction over);
    //   • an absolute ceiling that REJECTS, so a wedged apply becomes a failed restore
    //     with a reason instead of a row nobody can resolve.
    //
    // No idle watchdog, deliberately: the payload travels IN through stdin, so a long
    // silence is what a healthy loader looks like while it builds an index — nothing is
    // flowing because it stopped reading, not because it died. Abandoning that would
    // leave the target half-written on a restore that was fine.
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    let bodyEnded = false;
    let polling = true;

    const attachEnded = new Promise<ExecExitInfo>((resolve, reject) => {
      body.on("error", (err) => {
        try {
          (stream as unknown as { end?: () => void }).end?.();
        } catch {
          // best-effort
        }
        reject(err);
      });
      body.on("end", () => {
        bodyEnded = true;
      });
      stream.on("end", async () => {
        try {
          resolve({ code: await resolveExecExitCode(exec, exec.id), stderr: stderrTail() });
        } catch (err) {
          reject(err);
        }
      });
      stream.on("error", (err) => reject(err));
      // Pipe body → stdin. ssh2/dockerode hijack streams are
      // bidirectional; writing to it = stdin, reading = stdout/stderr
      // (demuxed above).
      body.pipe(stream as unknown as NodeJS.WritableStream);
    });

    // Gated on `bodyEnded` for the same reason `awaitHelperExit` gates its poll: an
    // exec that has not been handed all of its input yet is expected to still be
    // running. Resolving from a poll can clip the stderr TAIL — never data, which
    // travels the other way — and a truncated diagnostic beats a hang.
    const polledExit = async (): Promise<ExecExitInfo> => {
      while (polling) {
        await new Promise((r) => {
          const t = setTimeout(r, EXIT_POLL_INTERVAL_MS);
          (t as { unref?: () => void }).unref?.();
        });
        if (!polling || !bodyEnded) continue;
        let info: { Running?: boolean; ExitCode?: number | null };
        try {
          info = await exec.inspect();
        } catch {
          continue; // transient daemon hiccup — the ceiling still covers us
        }
        if (info.Running === false && typeof info.ExitCode === "number") {
          return { code: info.ExitCode, stderr: stderrTail() };
        }
      }
      // Only reachable after the race settled and the finally cleared the flag.
      return new Promise<never>(() => {});
    };

    try {
      return await withTimeout(
        Promise.race([attachEnded, polledExit()]),
        timeoutMs,
        `Restore into service ${service.name} exceeded its ` +
          `${Math.round(timeoutMs / 1000)}s ceiling and was abandoned. The target may hold ` +
          `partial data.`,
      );
    } finally {
      polling = false;
      // Drop the socket on every exit. On the ceiling this is what stops the write —
      // leaving it open kept a wedged loader fed while the row said failed.
      destroyQuietly(stream as unknown as { destroy?: (err?: Error) => void });
      destroyQuietly(body);
    }
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
    opts?: ExecuteCommandOpts,
    meta?: { label?: string },
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const label = meta?.label ?? "exec";
    const idleMs = opts?.idleTimeoutMs ?? DEFAULT_HELPER_IDLE_MS;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;

    const stdout = new PassThrough({ highWaterMark: ARTIFACT_BUFFER_BYTES });
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });

    // Our demuxer, not `modem.demuxStream`: this is the path every DB producer's
    // dump flows through, and modem discards the `false` from `stdout.write()`, so
    // a dump produced faster than the destination accepts it accumulated in this
    // PassThrough until the heap gave out (#633). See docker-demux.ts.
    //
    // A demux failure has to reach `awaitExit`, not just `stdout`: the exit code is
    // read from the attach stream's own `end`, which still fires after a desync, so
    // the run would otherwise record the exec's `0` over a truncated artifact.
    let demuxError: Error | null = null;
    let rejectExit: ((err: Error) => void) | null = null;
    demuxDockerStream(stream as unknown as NodeJS.ReadableStream, stdout, stderrSink, (err) => {
      // Recorded ALWAYS, and additionally pushed at the promise once one exists.
      // The demuxer can fail before `awaitExit` is constructed (its first `data`
      // event) or after, and both have to land — the record covers the early case,
      // the reject covers the case where nothing else will look at it again.
      demuxError ??= err;
      rejectExit?.(err);
    });

    // The demuxer only forwards frames — it never ends the destinations when the
    // source attach stream ends. Without this, a consumer piping stdout (pg_dump,
    // mysqldump, mongodump, custom commands → the destination writer) waits on an
    // EOF that never comes: the dump is fully written, the exec has exited, and
    // the run still sits in `uploading` forever (#516). demuxContainerStream
    // below carries the same fix for the volume/tar path.
    //
    // Safe to end here, and ONLY here: this path learns the exit code from the
    // attach stream's own 'end' (see awaitExit below), so by the time it fires
    // every byte has already been demuxed. Do not move this to a daemon-side exit
    // signal — an exec can exit with bytes still in flight, and ending early
    // truncates the artifact (the trap demuxContainerStream documents).
    let sinksEnded = false;
    const endSinks = () => {
      if (sinksEnded) return;
      sinksEnded = true;
      stdout.end();
      stderrSink.end();
    };
    stream.on("end", endSinks);
    stream.on("close", endSinks);

    const watchdog = createIdleWatchdog(
      idleMs,
      `${label} produced no data for ${Math.round(idleMs / 1000)}s and was abandoned.`,
    );
    stream.on("data", () => watchdog.touch());
    // A `drain` is forward progress too, and since backpressure landed this is the
    // only kind some healthy runs have. The watchdog used to mean "is the daemon
    // producing", which was the same question as "is anything happening" while the
    // demuxer read as fast as it could. Now a slow destination legitimately keeps the
    // attach socket PAUSED — no `data` events at all — so a watchdog fed only by the
    // source would abandon a backup that is moving, just slowly, and call it wedged.
    // The destination accepting more bytes is exactly the evidence that it is not.
    stdout.on("drain", () => watchdog.touch());

    const awaitExit = (async (): Promise<ExecExitInfo> => {
      const onEnd = new Promise<ExecExitInfo>((resolve, reject) => {
        // Adopt the demux error channel: whichever comes first wins, and a desync
        // that arrived before this promise existed is still pending in `demuxError`.
        rejectExit = reject;
        if (demuxError) reject(demuxError);
        stream.on("end", async () => {
          // The demuxer may have failed with the source still ending cleanly. Its
          // error outranks the exec's own status, which describes a process that
          // did finish — just not into bytes we can trust.
          if (demuxError) return reject(demuxError);
          try {
            resolve({
              code: await resolveExecExitCode(docker.getExec(execId), execId),
              stderr: Buffer.concat(stderrChunks)
                .toString("utf8")
                .slice(0, 16 * 1024),
            });
          } catch (err) {
            reject(err);
          }
        });
        stream.on("error", (err) => reject(err));
      });

      try {
        return await withTimeout(
          Promise.race([onEnd, watchdog.promise]),
          timeoutMs,
          `${label} exceeded its ${Math.round(timeoutMs / 1000)}s ceiling and was abandoned.`,
        );
      } catch (err) {
        stdout.destroy(err as Error);
        // Reap the attach socket too, which this path used to leave open.
        //
        // Backpressure is what made that matter. Nothing is going to drain this exec
        // now, so the socket sits PAUSED: the fd leaks, and `pg_dump` stays blocked
        // inside the user's database on a `write(2)` that will never complete — holding
        // its transaction snapshot open, which on a busy Postgres means bloat that
        // outlives the failed backup. `pipeIntoCommand` and `demuxContainerStream` both
        // already reap on their failure paths; this one was missed.
        destroyQuietly(stream as unknown as { destroy?: (err?: Error) => void });
        throw err;
      } finally {
        watchdog.dispose();
      }
    })();

    // A consumer legitimately stops awaiting this: the orchestrator's `for await` over
    // the producer finalizes the generator the moment an upload fails, so the
    // `await awaitExit` after the `yield` never runs. The idle watchdog then rejects
    // this promise ~10 minutes later with nobody listening — an unhandled rejection,
    // which is fatal on the Node-hosted desktop API. Attaching a no-op handler makes
    // the rejection observed; every real awaiter still sees it, because this is the
    // same promise object they hold.
    void awaitExit.catch(() => {});

    return { stdout, awaitExit };
  }

  private demuxContainerStream(
    container: Dockerode.Container,
    stream: NodeJS.ReadWriteStream,
    opts: { timeoutMs: number; idleTimeoutMs: number; label: string },
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const stdout = new PassThrough({ highWaterMark: ARTIFACT_BUFFER_BYTES });
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    // Backpressure-honoring demux — same reason as attachDemuxed above: `tar -c |
    // zstd` out of a large volume outruns any network destination, and the
    // difference has to stop at the attach socket rather than in this heap. And as
    // there, a desync must beat the helper's own exit status to `awaitExit`, or a
    // truncated archive is recorded as a complete one.
    let demuxError: Error | null = null;
    const demux = demuxDockerStream(
      stream as unknown as NodeJS.ReadableStream,
      stdout,
      stderrSink,
      (err) => {
        demuxError = err;
      },
    );
    /** Last moment payload moved in either direction — see the backstop below. */
    let lastProgressAt = Date.now();
    // The demuxer never ends the destinations. End `stdout` when the attach
    // stream itself ends (all output demuxed) — otherwise a consumer piping it
    // into `tar -x` stdin never sees EOF and hangs. This is RELIABLE only
    // because the helper has no AutoRemove (see streamPath): docker flushes the
    // output then closes the attach cleanly on exit. We must NOT end on
    // container.wait() — the container can exit while bytes are still buffered,
    // and ending early truncates the tar ("Restore helper exited 1").
    //
    // Reap only AFTER the sinks are ended, never merely after the container
    // exits. A force-remove tears down the attach socket, and the container can
    // exit with bytes still in flight — removing at exit truncates the tar,
    // which is the "Restore helper exited 1" this whole comment block is about.
    // Once endSinks has run the remaining bytes are in the PassThrough, where a
    // removed container can no longer affect them.
    let sinksEnded = false;
    let exited = false;
    const reapIfDone = () => {
      if (!sinksEnded || !exited) return;
      void container.remove({ force: true }).catch(() => {});
    };
    const endSinks = () => {
      stdout.end();
      stderrSink.end();
      sinksEnded = true;
      reapIfDone();
    };
    stream.on("end", endSinks);
    stream.on("close", endSinks);

    // Capture is bounded exactly like restore, through the same primitive: a
    // wall-clock ceiling alone had to choose between strangling an honest
    // multi-hour archive and never noticing a wedged one, and it chose wrong in
    // both directions — 1h flat, so a volume whose RESTORE is allowed six hours
    // could not be backed up at all. Silence is what distinguishes the two, and
    // `tar -c` emits continuously while it works.
    const watchdog = createIdleWatchdog(
      opts.idleTimeoutMs,
      `${opts.label} produced no data for ${Math.round(opts.idleTimeoutMs / 1000)}s and was ` +
        `abandoned. Nothing was written; the archive is incomplete and was not kept.`,
    );
    stream.on("data", () => {
      lastProgressAt = Date.now();
      watchdog.touch();
    });
    // Same reason as attachDemuxed: with backpressure in place a slow destination keeps
    // this socket paused, so downstream drain is the progress signal that keeps a slow
    // archive from being mistaken for a wedged one.
    stdout.on("drain", () => {
      lastProgressAt = Date.now();
      watchdog.touch();
    });

    const awaitExit = (async (): Promise<ExecExitInfo> => {
      try {
        // Poll for the exit only once the attach stream has ended: before that
        // the helper is SUPPOSED to be running, and a poll that resolved early
        // would report an archive complete while bytes were still buffered.
        const res = await this.awaitHelperExit(container, watchdog, () => sinksEnded, {
          timeoutMs: opts.timeoutMs,
          label: opts.label,
          note: "Nothing was written; the archive is incomplete and was not kept.",
        });
        exited = true;
        // Backstop for an attach whose end/close is never delivered (it happens over
        // the SSH-tunneled transport). It used to be a flat `setTimeout(endSinks, 3000)`
        // on the theory that "the container has exited so all output is pushed" — which
        // BACKPRESSURE invalidates, and invalidates in the worst possible direction.
        //
        // `awaitHelperExit` resolves as soon as the helper exits, and the helper exits
        // once the daemon has accepted its last bytes — which, while we are paused, are
        // still sitting in the socket and the bridge, not in `stdout`. Ending `stdout`
        // then strands them permanently: after `end()` Node emits no further `'drain'`,
        // so the paused demuxer can never resume, and `gateSink` would have discarded
        // the tail. Result: exit 0, a non-zero size, a sha256 that matches the truncated
        // bytes, and a `volume-*.tar.zst` missing its end — recorded as a complete
        // backup, on the DEFAULT producer. Exactly the class this pass exists to remove.
        //
        // So it keys on being IDLE AND EMPTY rather than on the clock, and re-arms while
        // either is false. `demux.pending()` covers the case a silence check cannot:
        // `stdout` at 4 MB emits `'drain'` only when its whole queue clears, so a slow
        // destination is legitimately silent for far longer than any fixed window.
        //
        // Measured against the real demuxer: 16 MB of frames into a 4 MB `stdout` with a
        // 64 KB/5ms consumer, ending the sink once while `pending()` was true delivered
        // 7,667,712 of 16,777,216 bytes — 9.1 MB gone, and `stdout` emitted NO error.
        // Note WHY there is no error: the demuxer was paused, so it never attempted the
        // write that `gateSink`'s write-after-end guard would have caught. The loss is by
        // STARVATION, not by writing to a closed sink, which is exactly why the
        // `pending()` gate here is the load-bearing half and that guard is only a second
        // line of defence.
        const armEndBackstop = (): void => {
          const timer = setTimeout(() => {
            if (sinksEnded) return;
            if (Date.now() - lastProgressAt < ATTACH_DRAIN_QUIET_MS || demux.pending()) {
              return armEndBackstop();
            }
            endSinks();
          }, ATTACH_DRAIN_QUIET_MS);
          (timer as { unref?: () => void }).unref?.();
        };
        armEndBackstop();
        reapIfDone();
        // `tar` can exit 0 having written an archive we could not read whole. The
        // helper's status describes the process, not the bytes.
        if (demuxError) throw demuxError;
        return {
          code: res.StatusCode,
          stderr: Buffer.concat(stderrChunks)
            .toString("utf8")
            .slice(0, 16 * 1024),
        };
      } catch (err) {
        // Nothing will drain this helper now, so reap directly rather than
        // through reapIfDone, which waits for a drain that is never coming. The
        // consumer learns via stdout as well as the rejection — it may be piping
        // the archive somewhere and never look at awaitExit until the end.
        stdout.destroy(err as Error);
        void container.remove({ force: true }).catch(() => {});
        throw err;
      } finally {
        watchdog.dispose();
      }
    })();

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
