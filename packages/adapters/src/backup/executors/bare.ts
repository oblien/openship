/** Backup capture and restore on bare SSH hosts using the shared command transport. */

import { Readable } from "node:stream";
import { shellQuote } from "@repo/core";
import { safeDumpCommand } from "../common/dump-pipeline";
import {
  backupShellCommand,
  pipeRestoreCommand,
  receiveCommandArchive,
} from "../common/command-restore";
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
import { captureCommandOutput } from "../common/command-stream";

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
    return (service.volumes ?? []).filter(Boolean).map((v) => {
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
    return captureCommandOutput(await exec.rawExec(backupShellCommand(cmd, opts)), opts);
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    if (opts?.quiesce) {
      throw new Error(
        "Quiesced volume backups require a Docker runtime; bare hosts cannot freeze a service for capture.",
      );
    }
    const compression = opts?.compression ?? "zstd";
    const excludeArgs = (opts?.exclude ?? []).map((p) => `--exclude=${shellQuote(p)}`).join(" ");
    const tarCmd = `tar ${compression === "gzip" ? "-cz" : "-c"} -C ${shellQuote(sourceId)} ${excludeArgs} .`;
    return this.execStream(
      service,
      safeDumpCommand(tarCmd, compression === "zstd" ? "zstd" : "none"),
      {
        timeoutMs: opts?.timeoutMs,
        idleTimeoutMs: opts?.idleTimeoutMs,
      },
    );
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    return receiveCommandArchive(
      (cmd, stream, options) => this.pipeIntoCommand(service, cmd, stream, options),
      targetSourceId,
      body,
      opts,
    );
  }

  async pipeIntoCommand(
    service: ServiceHandle,
    cmd: string[],
    body: Readable,
    opts?: ExecuteCommandOpts,
  ): Promise<ExecExitInfo> {
    const exec = this.executor();
    const scoped = <T>(signal: AbortSignal, work: () => Promise<T>) =>
      exec.runWithAbortSignal ? exec.runWithAbortSignal(signal, work) : work();
    return pipeRestoreCommand(
      {
        input: exec.execWithInput
          ? (command, stream, signal) => scoped(signal, () => exec.execWithInput!(command, stream))
          : undefined,
        stage: (localDir, remoteDir, signal) =>
          scoped(signal, () => exec.transferIn(localDir, remoteDir)),
        run: async (command, options) => {
          const capture = await this.execStream(service, ["sh", "-c", command], options);
          capture.stdout.resume();
          return capture.awaitExit;
        },
      },
      service.name,
      cmd,
      body,
      opts,
    );
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

registerExecutor("bare", (runtime) => {
  if (!(runtime instanceof BareRuntime)) {
    throw new Error(
      "BareBackupExecutor requires a BareRuntime instance. " +
        `Got: ${(runtime as { name?: string })?.name ?? typeof runtime}`,
    );
  }
  return new BareBackupExecutor(runtime);
});
