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
import { withTimeout } from "@repo/core";
import { DockerRuntime, resolveExecExitCode } from "../../runtime/docker";
import {
  daemonConnectionFrom,
  startAttachStream,
  startExecStream,
} from "../../runtime/docker-exec-stream";
import { isHostPathSource, scopedVolumeName } from "../../runtime/volume-namespace";
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
        const data = await this.dockerode.getContainer(service.containerId).inspect();
        const mounts = (data.Mounts ?? []) as Array<{
          Type?: string;
          Name?: string;
          Source?: string;
          Destination?: string;
        }>;
        return mounts
          .filter((m) => m.Type === "volume" || m.Type === "bind")
          .map(
            (m, i): BackupSource => ({
              id: m.Name ?? m.Source ?? `mount-${i}`,
              target: m.Destination ?? "",
              source: m.Name ?? m.Source ?? "",
              type: (m.Type as BackupSource["type"]) ?? "volume",
            }),
          );
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
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    // NO `hijack` — this is the single entry point for EVERY backup producer
    // (pg_dump, mysqldump, mongodump, redis, custom commands, pre/post hooks), and
    // hijack makes docker-modem ask for a connection upgrade. The daemon answers
    // `101 Switching Protocols`; under Bun (the api image and the compiled desktop
    // binary) node:http surfaces that as a plain `response`, so modem rejected with
    // `(HTTP code 101) unexpected` — i.e. every database backup on a Docker box
    // failed before a byte was read. Nothing here writes stdin, so there is no
    // reason to hijack at all; see DockerEdgeExecutor.run() for the same fix.
    const stream = await exec.start({ stdin: false });
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
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => ["--exclude", shellEscape(p)]);
    const tarFlags = compressionFlag(compression);
    const tarCmd =
      compression === "zstd"
        ? `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} . | zstd -c -3`
        : `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} .`;
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

    return this.handOffHelper(
      {
        Image: helperImage,
        Cmd: [
          "sh",
          "-c",
          compression === "zstd" ? `apk add --no-cache zstd >/dev/null 2>&1; ${tarCmd}` : tarCmd,
        ],
        HostConfig: hostConfig,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        // zstd isn't in alpine:3 and is apk-installed at runtime, which needs
        // egress; gzip/none use busybox built-ins and stay network-isolated.
        NetworkDisabled: compression !== "zstd",
      },
      async (helper) => {
        const stream = await helper.attach({
          stream: true,
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
    );
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

    const clearCmd = opts?.clearTarget ? `find /mnt -mindepth 1 -delete 2>/dev/null || true; ` : "";
    const untarCmd =
      compression === "zstd"
        ? `${clearCmd}zstd -d -c | tar -x -C /mnt`
        : `${clearCmd}tar -x${compressionFlag(compression)}f - -C /mnt`;

    return this.withHelper(
      {
        Image: helperImage,
        Cmd: [
          "sh",
          "-c",
          compression === "zstd"
            ? `apk add --no-cache zstd >/dev/null 2>&1; ${untarCmd}`
            : untarCmd,
        ],
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
          resolve({
            code: await resolveExecExitCode(exec, exec.id),
            stderr: Buffer.concat(stderrChunks)
              .toString("utf8")
              .slice(0, 16 * 1024),
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
    opts?: ExecuteCommandOpts,
    meta?: { label?: string },
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const label = meta?.label ?? "exec";
    const idleMs = opts?.idleTimeoutMs ?? DEFAULT_HELPER_IDLE_MS;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;

    const stdout = new PassThrough();
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });

    docker.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderrSink);

    // demuxStream only forwards 'data' — it never ends the destinations when the
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

    const awaitExit = (async (): Promise<ExecExitInfo> => {
      const onEnd = new Promise<ExecExitInfo>((resolve, reject) => {
        stream.on("end", async () => {
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
        throw err;
      } finally {
        watchdog.dispose();
      }
    })();

    return { stdout, awaitExit };
  }

  private demuxContainerStream(
    container: Dockerode.Container,
    stream: NodeJS.ReadWriteStream,
    opts: { timeoutMs: number; idleTimeoutMs: number; label: string },
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
    stream.on("data", () => watchdog.touch());

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
        // Backstop: over the SSH-tunneled attach the stream's end/close is not
        // always delivered. The container has exited so all output is pushed;
        // give the buffer a moment to drain, then force-close. Idempotent.
        setTimeout(endSinks, 3000);
        reapIfDone();
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
