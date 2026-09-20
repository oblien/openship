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
import { withTimeout, shellQuote } from "@repo/core";
import { safeRestoreCommand } from "../common/dump-pipeline";
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

/**
 * Absolute ceiling for a restore that this executor pushes INTO a host, matching the
 * docker executor's helper ceiling. `undefined` from a caller means "the executor's
 * default" — never "unbounded", which is what it used to mean here.
 */
const DEFAULT_RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Grace after `execStream`'s own kill before the staging path stops waiting for the
 * channel's close. The kill normally resolves `awaitExit`; this covers the case where
 * the channel is already gone and no close event will ever arrive.
 */
const KILL_GRACE_MS = 30_000;

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
      shellQuote(p),
    ]);
    const path = sourceId;
    const tarCmd =
      compression === "zstd"
        ? `tar -c -C ${shellQuote(path)} ${excludeArgs.join(" ")} . | zstd -c -3`
        : compression === "gzip"
          ? `tar -cz -C ${shellQuote(path)} ${excludeArgs.join(" ")} .`
          : `tar -c -C ${shellQuote(path)} ${excludeArgs.join(" ")} .`;
    // Forward the ceiling instead of dropping it: `timeoutMs` is declared on
    // StreamPathOpts, and accepting an option you ignore is how the custom-command
    // producer came to drop three of them. There is no idle equivalent here —
    // rawExec's channel closes when the SSH connection dies, which is the bound
    // the docker helper had to build for itself.
    return this.execStream(service, ["sh", "-c", tarCmd], { timeoutMs: opts?.timeoutMs });
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    const compression = opts?.compression ?? "zstd";

    // This used to be `rm -rf <target>/*; mkdir -p <target>; zstd -d | tar -x`, which
    // is the wipe-and-lie shape the docker executor was fixed for and this one was
    // not — the duplicated byte plane the module doc warns about, where a fix lands
    // on N-1 copies. Three defects compounded:
    //
    //   - the target was cleared FIRST, joined with `;`, so it happened whatever
    //     followed;
    //   - a pipeline exits with its LAST command's status, so a missing `zstd` was
    //     reported as tar's result;
    //   - and `tar -x` on an empty stream exits 0.
    //
    // Net: the maildirs were deleted, nothing was extracted, and the restore was
    // recorded as a success. `bytesWritten` is counted off `body`, so the caller even
    // saw a healthy byte count.
    //
    // Now: PROVE the decompressor exists, and only then destroy anything. There is no
    // `apk add` fallback the way the alpine helper has — this is somebody's mail
    // server, so installing packages onto it is not ours to do; refusing with a
    // reason is.
    const tool = compression === "zstd" ? "zstd" : compression === "gzip" ? "gzip" : null;
    const prelude = [
      `mkdir -p ${shellQuote(targetSourceId)}`,
      tool
        ? `command -v ${tool} >/dev/null 2>&1 || { echo "openship: '${tool}' is not installed ` +
          `on this host, so the artifact cannot be decompressed. Refusing to clear the ` +
          `target: nothing was written and your data is untouched." >&2; exit 90; }`
        : null,
      // Only now, with the decompressor proven present.
      opts?.clearTarget
        ? `rm -rf ${shellQuote(targetSourceId)}/* ${shellQuote(targetSourceId)}/.[!.]* 2>/dev/null || true`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    // `safeRestoreCommand` carries the fd idiom that reports BOTH sides of the pipe,
    // so a decompressor that fails can no longer hide behind tar's exit 0.
    const cmd = safeRestoreCommand(
      compression === "none" ? "none" : compression,
      `tar -x -C ${shellQuote(targetSourceId)}`,
      prelude,
    );

    let bytesWritten = 0;
    body.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.byteLength;
    });
    // Forward the ceiling the same way `streamPath` does. Dropping it here is what
    // left the extract with no bound at all, since `pipeIntoCommand` only had one
    // when a caller named one.
    const exit = await this.pipeIntoCommand(service, cmd, body, {
      timeoutMs: opts?.timeoutMs,
    });
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

    // Every restore through this executor now gets a ceiling whether or not the caller
    // named one. Neither `execWithInput` nor `transferIn` has a timeout of its own, and
    // the ceiling below used to apply only when `opts.timeoutMs` was set — which
    // `receiveStream` never passed. So a remote loader that wedges (a `psql` blocked on
    // a lock, an sshd that stopped reading its side of the pipe) left nothing that would
    // ever settle: the restore row sat in `applying` until a stale sweep guessed at it.
    // Same shape and same default as the docker executor, because a fix on one copy of
    // this byte plane is a fix on N-1 of them.
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS;
    const ceiling = (): string =>
      `Restore into ${service.name} exceeded its ${Math.round(timeoutMs / 1000)}s ceiling ` +
      `and was abandoned. The target may hold partial data.`;

    // STREAM when the executor can, and it can: `execWithInput` is on the SSH executor
    // and is documented as "the streaming inverse of rawExec", already used to pipe a
    // multi-GB `docker save` into `docker load` without staging. The comment that used to
    // sit here — "the CommandExecutor exposes no stdin-streaming primitive" — was true
    // when written and stale by the time it mattered.
    //
    // Staging is the module's last unbounded resource: it writes the ENTIRE artifact to
    // the API host's /tmp before sending it, so a mail-server restore needs local disk
    // equal to the backup (and moves the bytes twice). Everything else got a bound in the
    // #633 pass; this path kept none, and it fails as ENOSPC on the control plane rather
    // than as anything an operator can read.
    if (exec.execWithInput) {
      // ONE layer of quoting. This was `composeShell(...).replace(/^sh -c /, "")`,
      // which strips the prefix but leaves the single quotes `composeShell` added —
      // and then quotes the result AGAIN. ssh2 hands the string to the remote login
      // shell, which unwraps one layer, so `sh -c` received the literal text
      // `'<script>'`; sh stripped those quotes and tried to exec a command whose NAME
      // was the entire multi-line script, i.e. exit 127 having done nothing. Every
      // bare (mail-server) restore failed this way, while capture was fine because
      // execStream passes `composeShell` through quoted exactly once.
      const run = exec.execWithInput(`sh -c ${shellQuote(shellScript(cmd, opts))}`, body);
      // `execWithInput` has no timeout of its own. Closing the body is the teardown that
      // reaches the far side: the remote command sees EOF on stdin and exits.
      const result = await withTimeout(run, timeoutMs, ceiling()).catch((err) => {
        body.destroy();
        throw err;
      });
      return { code: result.code, stderr: result.stderr };
    }

    // ONE budget across the three sequential legs, so the ceiling bounds the whole
    // operation instead of being granted afresh to each of them. The floor is not
    // cosmetic: `withTimeout` treats a falsy `ms` as "no ceiling", so an exhausted
    // budget arriving as 0 would hand the last leg the unbounded wait this whole change
    // exists to remove.
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(1_000, deadline - Date.now());

    await fs.mkdir(localDir, { recursive: true });
    try {
      // Fallback for an executor without the streaming primitive (a local, non-SSH
      // CommandExecutor): stage the artifact, then transfer the dir onto the target.
      await withTimeout(pipeline(body, createWriteStream(localFile)), remaining(), ceiling());
      await withTimeout(exec.transferIn(localDir, remoteDir), remaining(), ceiling());

      // Same single-quoting rule as the streaming path above.
      const wrapped = `${shellScript(cmd, opts)} < ${shellQuote(remoteFile)}`;
      const runner = `sh -c ${shellQuote(wrapped)}; ec=$?; rm -rf ${shellQuote(remoteDir)}; exit $ec`;
      const { stdout, awaitExit } = await this.execStream(service, ["sh", "-c", runner], {
        ...opts,
        timeoutMs: remaining(),
      });
      stdout.resume(); // drain — caller doesn't consume restore stdout
      // `execStream`'s ceiling kills the channel, which is what normally settles
      // `awaitExit`. This is the backstop behind that one, for a channel that is
      // already gone and will never deliver a close.
      return await withTimeout(awaitExit, remaining() + KILL_GRACE_MS, ceiling());
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

/**
 * Bake env + cwd into ONE shell script — unquoted, so callers decide how many
 * layers of quoting their transport needs.
 *
 * Split out of `composeShell` because callers that need the raw script were getting
 * it by string-stripping `sh -c ` off a quoted result, which left the quotes on and
 * then added more. A builder that returns a quoted string cannot be un-quoted by
 * regex, so it has to be the composed script that is shared, not its wrapper.
 */
function shellScript(cmd: string[], opts?: ExecuteCommandOpts): string {
  const envPrefix = opts?.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ") + " "
    : "";
  const cwdPrefix = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
  // cmd is typically ["sh","-c","<script>"]; collapse to one shell string.
  const inner =
    cmd.length >= 3 && cmd[0] === "sh" && cmd[1] === "-c"
      ? cmd.slice(2).join(" ")
      : cmd.map((a) => shellQuote(a)).join(" ");
  return `${cwdPrefix}${envPrefix}${inner}`;
}

/** `shellScript` wrapped for a transport that takes one command string. */
function composeShell(cmd: string[], opts?: ExecuteCommandOpts): string {
  return `sh -c ${shellQuote(shellScript(cmd, opts))}`;
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
