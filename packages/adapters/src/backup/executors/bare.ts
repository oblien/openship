/** Backup capture and restore for bare applications using the shared command transport. */

import { Readable } from "node:stream";
import { shellQuote, appVolumeTargets, normalizeAppVolumes } from "@repo/core";
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
import { matchBackupSource } from "../common/source-match";

export class BareBackupExecutor implements BackupExecutor {
  readonly runtimeName = "bare" as const;

  constructor(private readonly runtime: BareRuntime) {}

  private executor() {
    const exec = this.runtime.commandExecutor;
    if (!exec.rawExec) {
      throw new Error(
        "Bare backups require a command transport that supports streaming.",
      );
    }
    return exec as typeof exec & { rawExec: NonNullable<typeof exec.rawExec> };
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    const volumes = normalizeAppVolumes(service.volumes);
    if (this.runtime.scopedProjectId || appVolumeTargets(volumes).length) {
      return this.runtime.persistentPaths(service.projectId, volumes).map(path => ({
        id: path.source, source: path.source, target: path.target, type: "bind" as const,
      }));
    }
    // Host-level sources (for example mail) explicitly name host directories.
    return service.volumes.filter(Boolean).map(spec => {
      const body = spec.replace(/:(?:ro|rw|z|Z|nocopy)$/, "");
      const path = body.includes(":") ? body.slice(body.indexOf(":") + 1) : body;
      if (!path.startsWith("/") || path.includes(":")) throw new Error("Host backup sources must be absolute paths");
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
    const source = matchBackupSource(await this.listSources(service), sourceId);
    if (!source) throw new Error(`Backup source does not belong to service ${service.name}`);
    await this.assertSource(service, source.source);
    const excludeArgs = (opts?.exclude ?? []).map((p) => `--exclude=${shellQuote(p)}`).join(" ");
    const tarCmd = `tar ${compression === "gzip" ? "-cz" : "-c"} -C ${shellQuote(source.source)} ${excludeArgs} .`;
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
    const source = matchBackupSource(await this.listSources(service), targetSourceId);
    if (!source) throw new Error(`Restore target does not belong to service ${service.name}`);
    await this.assertSource(service, source.source);
    return receiveCommandArchive(
      (cmd, stream, options) => this.pipeIntoCommand(service, cmd, stream, options),
      source.source,
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

  private async assertSource(service: ServiceHandle, source: string) {
    if (!this.runtime.scopedProjectId) return;
    const paths = this.runtime.persistentPaths(service.projectId, normalizeAppVolumes(service.volumes));
    if (!paths.some(path => path.source === source)) throw new Error("Backup path is outside this project");
    const resolved = (await this.executor().exec(`readlink -f -- ${shellQuote(source)}`)).trim();
    if (resolved !== source) throw new Error("Backup path points outside its persistent directory");
  }

  async stopService(service: ServiceHandle): Promise<void> {
    if (service.containerId) await this.runtime.stop(service.containerId);
  }
  async startService(service: ServiceHandle): Promise<void> {
    if (service.containerId) await this.runtime.start(service.containerId);
  }
  async isRunning(service: ServiceHandle): Promise<boolean> {
    if (service.containerId) return (await this.runtime.getContainerInfo(service.containerId)).status === "running";
    // Host-level mail producers own their daemon reload. A project without a
    // saved activation has no running app to stop or restore.
    return !service.projectId;
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
