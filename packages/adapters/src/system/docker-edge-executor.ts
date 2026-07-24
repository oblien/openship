import Dockerode from "dockerode";
import { PassThrough } from "node:stream";

import type { CommandExecutor, LogEntry } from "../types";
import { LocalExecutor } from "./local-executor";
import { logEntry } from "./local-shell";

const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * CommandExecutor for a CONTAINERIZED OpenResty edge (see apps/edge +
 * docker-compose `edge` service, `network_mode: host`).
 *
 * The api container and the edge container SHARE the routing volumes
 * (sites-enabled, /etc/letsencrypt, /var/www/acme), so FILE operations are
 * plain node:fs on those mounts — delegated to a `LocalExecutor`. Command
 * execution (`openresty -t` / `-s reload`, `certbot …`) runs INSIDE the edge
 * container via `docker exec` (dockerode). This lets `NginxProvider` — which
 * already speaks the CommandExecutor interface — drive the containerized edge
 * with no changes: it writes vhosts to the shared volume and reloads through us.
 *
 * The api reaches the Docker daemon through the mounted socket (DooD), the same
 * socket it uses to build/run app containers.
 */
export class DockerEdgeExecutor implements CommandExecutor {
  private readonly docker: Dockerode;
  private readonly containerName: string;
  /** Shared-volume file ops run locally (the volumes are mounted in the api). */
  private readonly files = new LocalExecutor();

  constructor(opts: { containerName: string; socketPath?: string }) {
    this.containerName = opts.containerName;
    this.docker = new Dockerode({ socketPath: opts.socketPath ?? DEFAULT_SOCKET });
  }

  /** Run one command inside the edge container, capturing stdout/stderr + exit. */
  private async run(
    command: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(this.containerName);
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: false });

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

  // ── File ops → shared volume (mounted in the api container) ──────────────
  writeFile(path: string, content: string): Promise<void> {
    return this.files.writeFile(path, content);
  }
  readFile(path: string): Promise<string> {
    return this.files.readFile(path);
  }
  exists(path: string): Promise<boolean> {
    return this.files.exists(path);
  }
  mkdir(path: string): Promise<void> {
    return this.files.mkdir(path);
  }
  rm(path: string): Promise<void> {
    return this.files.rm(path);
  }
  transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[]; alsoInclude?: string[] },
  ): Promise<void> {
    // Routing never transfers trees; the shared volume is same-filesystem anyway.
    return this.files.transferIn(localPath, remotePath, onLog, options);
  }

  async dispose(): Promise<void> {
    // Nothing persistent to close (dockerode is stateless over the socket).
  }
}
