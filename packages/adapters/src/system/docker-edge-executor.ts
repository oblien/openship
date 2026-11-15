import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import Dockerode from "dockerode";
import { PassThrough } from "node:stream";

import type { CommandExecutor, LogEntry } from "../types";
import { LocalExecutor } from "./local-executor";
import { logEntry, sq } from "./local-shell";
import { explainEdgeDown, isEdgeDownFailure } from "./edge-exec-error";
import { edgeFailureReason } from "./proxy/detect";
import { framedCatCommand, unframeFileRead } from "./exact-file-read";

const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * Where the edge's config files are reachable from:
 *
 *   "mounted"   — the routing volumes are mounted into THIS process (the compose
 *                 stack's api container, sharing sites-enabled / letsencrypt /
 *                 acme with the edge). File ops are plain node:fs. Default.
 *   "container" — they are not: the edge runs on a host we only reach through the
 *                 Docker daemon (a REMOTE server managed from desktop). File ops
 *                 go through `docker exec` in the edge container, so this needs no
 *                 host paths and no knowledge of the volume driver.
 */
export type EdgeFileMode = "mounted" | "container";

/** Cap per write command so a large file can't blow past the shell's ARG_MAX.
 *  Vhosts are a few KB; this only matters if something big is ever written. */
const WRITE_CHUNK = 60_000;

/**
 * CommandExecutor for a CONTAINERIZED OpenResty edge (see apps/edge +
 * docker-compose `edge` service, `network_mode: host`).
 *
 * Command execution (`openresty -t` / `-s reload`, `certbot …`) always runs
 * INSIDE the edge container via `docker exec` (dockerode). This lets
 * `NginxProvider` — which already speaks the CommandExecutor interface — drive
 * the containerized edge with no changes: it writes vhosts, then reloads through
 * us.
 *
 * File operations depend on where we're standing (see `EdgeFileMode`): the
 * compose stack's api shares the routing volumes and uses node:fs; a remote edge
 * reached only through the daemon writes via `docker exec`.
 *
 * Locally the api reaches the daemon through the mounted socket (DooD), the same
 * socket it uses to build/run app containers; for a remote server the caller
 * injects that server's SSH-tunneled dockerode.
 */
export class DockerEdgeExecutor implements CommandExecutor {
  private readonly docker: Dockerode;
  private readonly containerName: string;
  private readonly fileMode: EdgeFileMode;
  /** node:fs backend — used only in "mounted" mode, where the routing volumes
   *  really are in this process's filesystem. */
  private readonly files = new LocalExecutor();
  /** Metadata is available only when the file namespace is mounted locally. */
  readonly lstat?: CommandExecutor["lstat"];

  constructor(opts: {
    containerName: string;
    socketPath?: string;
    /** Injectable daemon client — tests use it to pin the exec options we send,
     *  and a REMOTE edge injects the server's SSH-tunneled dockerode here. */
    docker?: Dockerode;
    /** Defaults to "mounted" — today's compose-local behaviour. */
    fileMode?: EdgeFileMode;
  }) {
    this.containerName = opts.containerName;
    this.docker = opts.docker ?? new Dockerode({ socketPath: opts.socketPath ?? DEFAULT_SOCKET });
    this.fileMode = opts.fileMode ?? "mounted";
    if (this.fileMode === "mounted") this.lstat = this.files.lstat.bind(this.files);
  }

  /**
   * Why the edge refused (or couldn't answer) a command, in one operator-facing
   * line — the dockerode counterpart of `edgeContainerExecutor`'s host-shell probe.
   *
   * Reads the state and the log through the daemon API rather than a shell, which is
   * the whole reason `edgeFailureReason` is a pure parser: the two transports agree
   * on what counts as the cause without sharing a channel. Best-effort — a probe
   * that fails must not replace the real failure with an error about diagnosing it.
   *
   * The condition this exists for used to be reported as `(HTTP code 409) … container
   * <64-hex-id> is not running`: the RESOLVED id, no name, no cause. During `openship
   * up` migration that surfaced as six identical 409s against the edge's own id while
   * it was still starting, and from the cert flow it surfaced as a container the
   * operator had no reason to think was involved at all.
   */
  private async explainDown(err: unknown): Promise<Error> {
    const message = (err as { message?: string })?.message ?? String(err);
    const container = this.docker.getContainer(this.containerName);
    const status = await container
      .inspect()
      .then((info) => info.State?.Status ?? null)
      .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/system/docker-edge-executor"); return null; });
    const logs = await container
      .logs({ stdout: true, stderr: true, tail: 40, follow: false })
      .then((out) => (Buffer.isBuffer(out) ? out.toString("utf8") : String(out)))
      .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/system/docker-edge-executor"); return null; });
    const explanation = explainEdgeDown({
      container: this.containerName,
      status,
      reason: logs ? edgeFailureReason(logs) : null,
    });
    return new Error(`${explanation}\n${message}`);
  }

  /** Run one command inside the edge container, capturing stdout/stderr + exit. */
  /**
   * Run one command inside the edge container, capturing stdout/stderr + exit.
   *
   * `timeoutMs` (when provided) is ENFORCED here at the executor level across
   * EVERY asynchronous phase — exec creation, exec start, the output-stream
   * wait, and each inspection — so a stalled daemon connection cannot hang the
   * caller (e.g. reconciliation awaiting a TCP probe) indefinitely no matter
   * WHICH phase stalls. On expiry the demux stream is destroyed, dropping the
   * exec's output connection for the daemon to reap. Python's own socket
   * timeout bounds the probe process; this bounds the transport around it.
   * No timeout = unbounded, as before (certbot runs).
   */
  /**
   * Race ANY operation against a fresh `timeoutMs` budget, with a phase-named
   * rejection. Shared by run()'s per-phase remaining-time races and by the
   * diagnostic paths that run after a command completed (a hung inspection
   * must not reintroduce the wait the caller's timeout exists to prevent).
   */
  private withDeadlineOp<T>(
    operation: Promise<T>,
    phase: string,
    timeoutMs?: number,
    command?: string,
    budgetMs?: number,
  ): Promise<T> {
    // STABLE MESSAGE: `timeoutMs` is the REMAINING budget (phases share one
    // absolute deadline, so it drifts toward 0) — reporting it would make the
    // same caller request log "after 187ms" once and "after 3ms" the next.
    // The message reports the caller's REQUESTED timeout instead.
    const reported = budgetMs ?? timeoutMs;
    const timeoutError = (): Error =>
      new Error(
        `command timed out after ${reported}ms while ${phase} in edge container ${this.containerName}${command ? `: ${command.slice(0, 120)}` : ""}`,
      );
    // undefined = no deadline requested (stay unbounded); an EXPIRED budget
    // (<= 0 remaining) is an immediate timeout — never "run unbounded".
    if (timeoutMs === undefined) return operation;
    if (timeoutMs <= 0) {
      // The operation is ALREADY STARTED (its promise was created by the caller
      // before this call). An immediate timeout must still observe it, or its
      // eventual failure after the deadline becomes an unhandled rejection
      // (reproduced: an exit inspection failing after the deadline expired).
      void operation.catch(() => {});
      return Promise.reject(timeoutError());
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      timer.unref?.();
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private async run(
    command: string,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : null;
    const timeoutError = (phase: string) =>
      new Error(
        `command timed out after ${timeoutMs}ms while ${phase} in edge container ${this.containerName}: ${command.slice(0, 120)}`,
      );
    /** Race ANY operation against the single deadline, reporting the requested budget. */
    const withDeadline = <T>(operation: Promise<T>, phase: string): Promise<T> =>
      this.withDeadlineOp(
        operation,
        phase,
        deadline !== null ? Math.max(0, deadline - Date.now()) : undefined,
        command,
        timeoutMs,
      );

    const container = this.docker.getContainer(this.containerName);
    let exec: Dockerode.Exec;
    let stream: NodeJS.ReadWriteStream;
    try {
      exec = await withDeadline(
        container.exec({
          Cmd: ["/bin/sh", "-c", command],
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
        }),
        "creating the exec",
      );
      // NO `hijack` — and it must stay that way. Hijack makes docker-modem request a
      // connection upgrade; the daemon answers `101 Switching Protocols`, and Bun's
      // node:http does not surface that upgrade the way modem expects, so every exec
      // died with `(HTTP code 101) unexpected`. The api image runs Bun, so in
      // docker-edge mode that broke EVERY edge operation — config reload, certbot,
      // and site registration all failed while the edge itself looked healthy.
      // Verified both ways under Bun: hijack=true → 101; hijack=false → stdout,
      // stderr and exit code all correct. Hijack only exists for interactive stdin,
      // which no edge command uses.
      stream = await withDeadline(exec.start({ stdin: false }), "starting the exec");
    } catch (err) {
      // The daemon refuses the exec outright when the edge isn't up. Rewrite it into
      // the named container plus its `[emerg]`; anything else is a genuine transport
      // error and must reach the caller untouched (a 101 upgrade failure diagnosed as
      // "the edge is down" would send an operator after the wrong thing entirely).
      const message = (err as { message?: string })?.message ?? String(err);
      if (isEdgeDownFailure(message) || /\b409\b/.test(message)) {
        // Edge-down diagnostics inspect the container and read its logs — dockerode
        // awaits that can stall exactly like the call that failed. A 409 followed
        // by a hung inspection must not reintroduce the hang the deadline exists
        // to prevent: diagnostics are bounded by the REMAINING deadline, falling
        // back to the original error when they stall or the deadline already
        // expired. Without a deadline, diagnostics stay unbounded as before.
        const explain = (): Error => (err instanceof Error ? err : new Error(message));
        let diagnostic: Promise<Error> = this.explainDown(err);
        if (deadline !== null) {
          const remaining = deadline - Date.now();
          diagnostic =
            remaining <= 0
              ? Promise.resolve(explain())
              : withDeadline(this.explainDown(err), "diagnosing the edge failure").catch(() => explain());
        }
        throw await diagnostic;
      }
      throw err instanceof Error ? err : new Error(message);
    }

    const outStream = new PassThrough();
    const errStream = new PassThrough();
    // Demux outputs have no other listener: once the demux pipe is torn down
    // (stream.destroy() on deadline expiry), modem can still write/destroy into
    // them, and an unhandled stream 'error' event would CRASH the process
    // instead of failing the command. Output collected so far stays readable.

    // Demux outputs have no other listener: once the demux pipe is torn down
    // (stream.destroy() on deadline expiry), modem can still write/destroy into
    // them, and an unhandled stream 'error' event would CRASH the process
    // instead of failing the command. Output collected so far stays readable.
    // Demux outputs have no other listener: once the demux pipe is torn down
    // (stream.destroy() on deadline expiry), modem can still write/destroy into
    // them, and an unhandled stream 'error' event would CRASH the process
    // instead of failing the command. Output collected so far stays readable.
    // Demux outputs have no other listener: once the demux pipe is torn down
    // (stream.destroy() on deadline expiry), modem can still write/destroy into
    // them, and an unhandled stream 'error' event would CRASH the process
    // instead of failing the command. Output collected so far stays readable.
    outStream.on("error", () => {});
    errStream.on("error", () => {});
    let stdout = "";
    let stderr = "";
    outStream.on("data", (c: Buffer) => (stdout += c.toString()));
    errStream.on("data", (c: Buffer) => (stderr += c.toString()));
    // Split dockerode's multiplexed (non-TTY) stream into stdout/stderr.
    this.docker.modem.demuxStream(stream, outStream, errStream);

    // The output wait races the deadline like every other phase; expiry ALSO
    // destroys the demux pipe, dropping the connection for the daemon to reap.
    let destroyTimer: NodeJS.Timeout | null = null;
    if (deadline !== null) {
      destroyTimer = setTimeout(() => {
        (stream as unknown as import("node:stream").Readable).destroy();
      }, Math.max(0, deadline - Date.now()));
      destroyTimer.unref?.();
    }
    try {
      await withDeadline(
        new Promise<void>((resolve, reject) => {
          stream.on("end", () => resolve());
          stream.on("error", reject);
        }),
        "waiting for output",
      );
    } finally {
      if (destroyTimer) clearTimeout(destroyTimer);
    }
    outStream.end();
    errStream.end();

    // dockerode can still report Running:true / ExitCode:null in the window right
    // after the output stream ends. Poll until the exec has actually exited so a
    // null ExitCode isn't read as success (which would mask a failed
    // `openresty -t` / certbot). Each inspection is deadline-raced (a stalled
    // daemon hangs inspect just like any other call); the whole poll is bounded
    // (~5s without a deadline), then still-running is treated as failure.
    let info = await withDeadline(exec.inspect(), "inspecting the exec");
    for (let i = 0; info.Running && i < 50; i++) {
      if (deadline !== null && Date.now() > deadline) throw timeoutError("waiting for exit");
      await new Promise((r) => setTimeout(r, 100));
      info = await withDeadline(exec.inspect(), "inspecting the exec");
    }
    return { code: info.ExitCode ?? (info.Running ? 1 : 0), stdout, stderr };
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    // ONE absolute deadline spans execution AND diagnostics: a fresh budget
    // here would let a slow command plus stalled diagnostics take 2× the
    // caller's timeout (reproduced at 354ms with a 200ms timeout).
    const deadline = opts?.timeout && opts.timeout > 0 ? Date.now() + opts.timeout : null;
    const remaining = () => (deadline !== null ? deadline - Date.now() : undefined);
    const { code, stdout, stderr } = await this.run(command, remaining());
    if (code !== 0) {
      // Fold both streams like LocalExecutor — certbot prints its real cause to
      // stdout while stderr carries boilerplate.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      // The exec RAN, so the container was alive when it started — and the command
      // still reported the edge as absent. `openresty -s reload` finding an empty pid
      // file is the case that matters: nginx is PID 1 here, so the master is already
      // gone and the container is about to be restarted under us. Diagnosing it the
      // same way keeps "invalid PID number" from reading as a config problem.
      if (isEdgeDownFailure(detail)) {
        // Diagnostics hang like any dockerode await (a hung container inspection
        // never rejects, and explainDown swallows rejections into nulls). Bound
        // them by the REMAINING deadline — when they stall (or the budget is
        // spent), the completed command's own detail is the honest error.
        const fallback = (): Error =>
          new Error(detail || `command exited ${code} in edge container ${this.containerName}`);
        const diagnostic = this.explainDown(new Error(detail));
        throw await this.withDeadlineOp(
          diagnostic,
          "diagnosing the edge failure",
          remaining(),
          command,
          opts?.timeout,
        ).catch(fallback);
      }
      throw new Error(
        detail || `command exited ${code} in edge container ${this.containerName}`,
      );
    }
    return stdout.trim();
  }

  async streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    // Edge commands (reload/certbot) are short; capture then emit once. Keeps
    // the interface satisfied without a second live-attach path.
    const { code, stdout, stderr } = await this.run(command);
    const output = [stdout, stderr].filter(Boolean).join("");
    if (output) onLog(logEntry(output, code === 0 ? "info" : "error"));
    // Streamed failures are reported, not thrown, and the caller builds its error out
    // of what was streamed — so the explanation has to go through `onLog` to reach it.
    if (code !== 0 && isEdgeDownFailure(output)) {
      const explanation = (await this.explainDown(new Error(output))).message.split("\n")[0]!;
      onLog(logEntry(explanation, "error"));
      return { code, output: `${explanation}\n${output}` };
    }
    return { code, output };
  }

  // ── File ops ─────────────────────────────────────────────────────────────
  // "mounted": the shared volume is in this process's filesystem → node:fs.
  // "container": reach it through the daemon → `docker exec` in the edge.

  /** Same fileMode split as every other file op — never a bare `docker exec mv`. */
  async rename(from: string, to: string): Promise<void> {
    if (this.fileMode === "mounted") {
      await this.files.rename(from, to);
      return;
    }
    const { code, stderr } = await this.run(`mv ${sq(from)} ${sq(to)}`);
    if (code !== 0) throw new Error(stderr.trim() || `Failed to rename ${from}`);
  }

  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    if (this.fileMode === "mounted") {
      return opts === undefined
        ? this.files.writeFile(path, content)
        : this.files.writeFile(path, content, opts);
    }

    // base64 in the COMMAND, never on stdin: `run()` deliberately doesn't hijack
    // the connection (see the note above — hijack breaks every exec under Bun),
    // so there is no stdin to pipe through. Chunked append keeps each command
    // well inside ARG_MAX for content larger than a vhost.
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const dir = path.replace(/\/[^/]*$/, "");
    if (dir && dir !== path) await this.exec(`mkdir -p ${sq(dir)}`);
    if (opts?.mode !== undefined) {
      // Tighten the destination before the first decoded payload byte lands.
      await this.exec(`: > ${sq(path)} && chmod ${opts.mode.toString(8)} ${sq(path)}`);
    }
    if (encoded.length === 0) {
      if (opts?.mode === undefined) await this.exec(`: > ${sq(path)}`);
      return;
    }
    for (let offset = 0; offset < encoded.length; offset += WRITE_CHUNK) {
      const chunk = encoded.slice(offset, offset + WRITE_CHUNK);
      const redirect = offset === 0 && opts?.mode === undefined ? ">" : ">>";
      await this.exec(`printf '%s' ${sq(chunk)} | base64 -d ${redirect} ${sq(path)}`);
    }
  }

  async readFile(path: string): Promise<string> {
    if (this.fileMode === "mounted") return this.files.readFile(path);
    // Framed: `exec` trims its output, and a file read must come back byte-exact.
    return unframeFileRead(await this.exec(framedCatCommand(path)), path);
  }

  async exists(path: string): Promise<boolean> {
    if (this.fileMode === "mounted") return this.files.exists(path);
    // `test` reports absence via exit code — that's an answer, not a failure, so
    // check the code instead of letting exec() throw.
    const { code } = await this.run(`test -e ${sq(path)}`);
    return code === 0;
  }

  async mkdir(path: string): Promise<void> {
    if (this.fileMode === "mounted") return this.files.mkdir(path);
    await this.exec(`mkdir -p ${sq(path)}`);
  }

  async rm(path: string): Promise<void> {
    if (this.fileMode === "mounted") return this.files.rm(path);
    await this.exec(`rm -rf ${sq(path)}`);
  }

  transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[]; alsoInclude?: string[] },
  ): Promise<void> {
    if (this.fileMode === "container") {
      // Routing never transfers trees, and there's no meaningful local source on
      // the other side of a remote daemon — fail loudly rather than half-work.
      return Promise.reject(
        new Error("transferIn is not supported against a container-mode edge"),
      );
    }
    // Routing never transfers trees; the shared volume is same-filesystem anyway.
    return this.files.transferIn(localPath, remotePath, onLog, options);
  }

  async dispose(): Promise<void> {
    // Nothing persistent to close (dockerode is stateless over the socket).
  }
}
