import Dockerode from "dockerode";
import { PassThrough } from "node:stream";

import type { CommandExecutor, LogEntry } from "../types";
import { LocalExecutor } from "./local-executor";
import { logEntry, sq } from "./local-shell";

const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * Turn dockerode's opaque "container is not running" 409 into a message that
 * names the edge and says what to do.
 *
 * A `docker exec` against a container that isn't running throws the daemon's raw
 * `(HTTP code 409) … container <id> is not running`. It prints the RESOLVED id,
 * not the name, so the error reads like an unrelated app/upstream failure. During
 * `openship up` migration this surfaced as SIX identical 409s against the edge's
 * OWN id while the edge container was still starting — a race, not a broken site.
 */
function explainEdgeExecError(err: unknown, containerName: string): Error {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/is not running|not running|409/i.test(msg)) {
    return new Error(
      `edge container "${containerName}" is not running yet (still starting, or stopped) — ` +
        `wait for it to be up (docker start ${containerName}) and retry.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

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
  }

  /** Run one command inside the edge container, capturing stdout/stderr + exit. */
  private async run(
    command: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(this.containerName);
    let exec: Dockerode.Exec;
    let stream: NodeJS.ReadWriteStream;
    try {
      exec = await container.exec({
        Cmd: ["/bin/sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      // NO `hijack` — and it must stay that way. Hijack makes docker-modem request a
      // connection upgrade; the daemon answers `101 Switching Protocols`, and Bun's
      // node:http does not surface that upgrade the way modem expects, so every exec
      // died with `(HTTP code 101) unexpected`. The api image runs Bun, so in
      // docker-edge mode that broke EVERY edge operation — config reload, certbot,
      // and site registration all failed while the edge itself looked healthy.
      // Verified both ways under Bun: hijack=true → 101; hijack=false → stdout,
      // stderr and exit code all correct. Hijack only exists for interactive stdin,
      // which no edge command uses.
      stream = await exec.start({ stdin: false });
    } catch (err) {
      // A not-yet-running edge here 409s with an id, not a name — rewrite it so the
      // caller sees "edge is still starting", not a bare Docker error. See #291-era
      // migration race: the reload raced the edge container's own startup.
      throw explainEdgeExecError(err, this.containerName);
    }

    const outStream = new PassThrough();
    const errStream = new PassThrough();
    let stdout = "";
    let stderr = "";
    outStream.on("data", (c: Buffer) => (stdout += c.toString()));
    errStream.on("data", (c: Buffer) => (stderr += c.toString()));
    // Split dockerode's multiplexed (non-TTY) stream into stdout/stderr.
    this.docker.modem.demuxStream(stream, outStream, errStream);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    outStream.end();
    errStream.end();

    // dockerode can still report Running:true / ExitCode:null in the window right
    // after the output stream ends. Poll until the exec has actually exited so a
    // null ExitCode isn't read as success (which would mask a failed
    // `openresty -t` / certbot). Bounded (~5s), then treat still-running as failure.
    let info = await exec.inspect();
    for (let i = 0; info.Running && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      info = await exec.inspect();
    }
    return { code: info.ExitCode ?? (info.Running ? 1 : 0), stdout, stderr };
  }

  async exec(command: string): Promise<string> {
    const { code, stdout, stderr } = await this.run(command);
    if (code !== 0) {
      // Fold both streams like LocalExecutor — certbot prints its real cause to
      // stdout while stderr carries boilerplate.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
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

  async writeFile(path: string, content: string): Promise<void> {
    if (this.fileMode === "mounted") return this.files.writeFile(path, content);

    // base64 in the COMMAND, never on stdin: `run()` deliberately doesn't hijack
    // the connection (see the note above — hijack breaks every exec under Bun),
    // so there is no stdin to pipe through. Chunked append keeps each command
    // well inside ARG_MAX for content larger than a vhost.
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const dir = path.replace(/\/[^/]*$/, "");
    if (dir && dir !== path) await this.exec(`mkdir -p ${sq(dir)}`);
    if (encoded.length === 0) {
      await this.exec(`: > ${sq(path)}`);
      return;
    }
    for (let offset = 0; offset < encoded.length; offset += WRITE_CHUNK) {
      const chunk = encoded.slice(offset, offset + WRITE_CHUNK);
      const redirect = offset === 0 ? ">" : ">>";
      await this.exec(`printf '%s' ${sq(chunk)} | base64 -d ${redirect} ${sq(path)}`);
    }
  }

  async readFile(path: string): Promise<string> {
    if (this.fileMode === "mounted") return this.files.readFile(path);
    return this.exec(`cat ${sq(path)}`);
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
