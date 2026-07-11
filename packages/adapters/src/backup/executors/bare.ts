/**
 * BareBackupExecutor — backup primitives for bare SSH hosts (no Docker,
 * no cloud workspace). Used for sources that are a plain server the
 * orchestrator reaches over SSH — e.g. a mail server (iRedMail): the
 * `vmail` Postgres dump + `/var/vmail` maildirs.
 *
 * It drives the pooled `CommandExecutor` the BareRuntime already holds:
 *   - execStream / streamPath → `rawExec` (raw stdout Readable) so a
 *     multi-GB `pg_dump | zstd` or `tar | zstd` streams byte-for-byte to
 *     the destination without staging.
 *   - pipeIntoCommand / receiveStream (restore) → stage the artifact to a
 *     local temp dir, `transferIn` it to a remote temp dir, then run the
 *     restore command reading from it. (The CommandExecutor exposes no
 *     stdin-streaming primitive; staging reuses the existing tar-pipe
 *     transfer instead of opening a second raw ssh2 channel.)
 *
 * The BareRuntime comes in through the factory at registration time,
 * mirroring the Docker/Cloud executors' runtime-injection pattern.
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BareRuntime } from "../../runtime/bare";
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

export class BareBackupExecutor implements BackupExecutor {
  readonly runtimeName = "bare" as const;

  constructor(private readonly runtime: BareRuntime) {}

  private executor() {
    const exec = this.runtime.commandExecutor;
    if (!exec.rawExec) {
      throw new Error(
        "BareBackupExecutor requires an SSH executor (rawExec) — a local host can't stream backups over a raw channel.",
      );
    }
    return exec as typeof exec & { rawExec: NonNullable<typeof exec.rawExec> };
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    // Volume strings are bare host paths for a bare source (e.g.
    // "/var/vmail"). Take the last colon segment defensively in case a
    // compose-style "name:/path" slipped through.
    return (service.volumes ?? [])
      .filter(Boolean)
      .map((v) => {
        const path = v.includes(":") ? (v.split(":").pop() as string) : v;
        return { id: path, source: path, target: path, type: "bind" as const };
      });
  }

  async execStream(
    service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    const exec = this.executor();
    const { stdout, stderr, onClose, kill } = await exec.rawExec(
      composeShell(cmd, opts),
    );

    let stderrBuf = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 16 * 1024) stderrBuf = stderrBuf.slice(-16 * 1024);
    });
    stderr.resume();

    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          try {
            kill();
          } catch {
            /* already gone */
          }
        }, opts.timeoutMs)
      : null;

    const awaitExit = onClose.then((code): ExecExitInfo => {
      if (timer) clearTimeout(timer);
      return { code, stderr: stderrBuf };
    });

    return { stdout, awaitExit };
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    const compression = opts?.compression ?? "zstd";
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => [
      "--exclude",
      shellEscape(p),
    ]);
    const path = sourceId;
    const tarCmd =
      compression === "zstd"
        ? `tar -c -C ${shellEscape(path)} ${excludeArgs.join(" ")} . | zstd -c -3`
        : compression === "gzip"
          ? `tar -cz -C ${shellEscape(path)} ${excludeArgs.join(" ")} .`
          : `tar -c -C ${shellEscape(path)} ${excludeArgs.join(" ")} .`;
    return this.execStream(service, ["sh", "-c", tarCmd]);
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    const compression = opts?.compression ?? "zstd";
    const decompress =
      compression === "zstd" ? "zstd -d | " : compression === "gzip" ? "gzip -d | " : "";
    const clear = opts?.clearTarget
      ? `rm -rf ${shellEscape(targetSourceId)}/* ${shellEscape(targetSourceId)}/.[!.]* 2>/dev/null; `
      : "";
    const cmd = `${clear}mkdir -p ${shellEscape(targetSourceId)}; ${decompress}tar -x -C ${shellEscape(targetSourceId)}`;
    let bytesWritten = 0;
    body.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.byteLength;
    });
    const exit = await this.pipeIntoCommand(service, ["sh", "-c", cmd], body);
    if (exit.code !== 0) {
      throw new Error(
        `receiveStream tar-extract exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    }
    return { bytesWritten };
  }

  async pipeIntoCommand(
    service: ServiceHandle,
    cmd: string[],
    body: Readable,
    opts?: ExecuteCommandOpts,
  ): Promise<ExecExitInfo> {
    const exec = this.executor();
    const id = randomBytes(6).toString("hex");
    const localDir = join(tmpdir(), `openship-bare-restore-${id}`);
    const localFile = join(localDir, "artifact.bin");
    const remoteDir = `/tmp/openship-bare-restore-${id}`;
    const remoteFile = `${remoteDir}/artifact.bin`;

    await fs.mkdir(localDir, { recursive: true });
    try {
      // Stage the artifact locally, then transfer the dir onto the target
      // (the CommandExecutor exposes no stdin-streaming primitive).
      await pipeline(body, createWriteStream(localFile));
      await exec.transferIn(localDir, remoteDir);

      const wrapped = `${composeShell(cmd, opts).replace(/^sh -c /, "")} < ${shellEscape(remoteFile)}`;
      const runner = `sh -c ${shellEscape(wrapped)}; ec=$?; rm -rf ${shellEscape(remoteDir)}; exit $ec`;
      const { stdout, awaitExit } = await this.execStream(service, ["sh", "-c", runner], opts);
      stdout.resume(); // drain — caller doesn't consume restore stdout
      return await awaitExit;
    } finally {
      await fs.rm(localDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Mail (and other bare) sources are long-lived services we don't cycle
  // wholesale for a backup — the produce/restore commands handle any
  // per-daemon reload themselves. Treat lifecycle as no-ops / always-up.
  async stopService(): Promise<void> {
    /* no-op: bare services aren't stopped for backup */
  }
  async startService(): Promise<void> {
    /* no-op */
  }
  async isRunning(): Promise<boolean> {
    return true;
  }
}

/** Bake env + cwd into a single `sh -c` command string. */
function composeShell(cmd: string[], opts?: ExecuteCommandOpts): string {
  const envPrefix = opts?.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `${k}=${shellEscape(v)}`)
        .join(" ") + " "
    : "";
  const cwdPrefix = opts?.cwd ? `cd ${shellEscape(opts.cwd)} && ` : "";
  // cmd is typically ["sh","-c","<script>"]; collapse to one shell string.
  const inner =
    cmd.length >= 3 && cmd[0] === "sh" && cmd[1] === "-c"
      ? cmd.slice(2).join(" ")
      : cmd.map((a) => shellEscape(a)).join(" ");
  return `sh -c ${shellEscape(`${cwdPrefix}${envPrefix}${inner}`)}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

registerExecutor("bare", (runtime) => {
  if (!(runtime instanceof BareRuntime)) {
    throw new Error(
      "BareBackupExecutor requires a BareRuntime instance. " +
        `Got: ${(runtime as { name?: string })?.name ?? typeof runtime}`,
    );
  }
  return new BareBackupExecutor(runtime);
});
