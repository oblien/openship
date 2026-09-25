/**
 * Backup primitives for legacy native Cloud workspaces. Modern Cloud Docker
 * services resolve to DockerBackupExecutor in the shared registry.
 *
 * Capture uses CloudWorkspaceExecutor's binary command transport. Restore
 * stages one private file through the SDK's tar.gz directory-upload endpoint,
 * then invokes the same command/archive restore logic used on SSH hosts.
 * Offline volume restore is unsupported: stopping the workspace stops the
 * filesystem API too. The orchestrator refuses it before destructive work.
 */

import { Readable } from "node:stream";
import { shellQuote } from "@repo/core";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import * as tarFs from "tar-fs";
import {
  backupShellCommand,
  pipeRestoreCommand,
  receiveCommandArchive,
} from "../common/command-restore";
import { CloudRuntime } from "../../runtime/cloud";
import { CloudWorkspaceExecutor } from "../../runtime/cloud/workspace-executor";
import { captureCommandOutput, CAPTURE_TIMEOUT_MS } from "../common/command-stream";
import { safeDumpCommand } from "../common/dump-pipeline";
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

/** Default backup target inside the workspace. Most apps land at /app. */
const DEFAULT_BACKUP_PATH = "/app";

export class CloudBackupExecutor implements BackupExecutor {
  readonly runtimeName = "cloud" as const;
  readonly supportsOfflineVolumeRestore = false;

  constructor(private readonly runtime: CloudRuntime) {}

  private get client() {
    return (this.runtime as unknown as { client: import("oblien").Oblien }).client;
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    // No granular volume concept on Oblien — the workspace's writable
    // disk is the unit. Future enhancement: parse service.volumes for
    // explicit backup-path overrides (e.g. ["/var/lib/postgresql/data"]).
    if (!service.containerId) return [];
    return [
      {
        id: DEFAULT_BACKUP_PATH,
        source: service.containerId,
        target: DEFAULT_BACKUP_PATH,
        type: "workspace-disk",
      },
    ];
  }

  async execStream(
    service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    if (!service.containerId) {
      throw new Error(`Cannot exec in cloud service ${service.name}: no workspace id`);
    }
    const ws = this.client.workspace(service.containerId);
    // Reuse the workspace's binary-safe command transport and verified exit
    // status. Backup-specific cancellation and idle bounds live in the same
    // stream lifecycle as SSH captures.
    const command = new CloudWorkspaceExecutor(() => ws.runtime());
    try {
      const child = await command.rawExec(backupShellCommand(cmd, opts), {
        timeoutSeconds: Math.ceil((opts?.timeoutMs ?? CAPTURE_TIMEOUT_MS) / 1000),
      });
      const capture = captureCommandOutput(child, opts);
      const awaitExit = capture.awaitExit.finally(() => command.dispose());
      void awaitExit.catch(() => {});
      return { stdout: capture.stdout, awaitExit };
    } catch (error) {
      await command.dispose();
      throw error;
    }
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    if (opts?.quiesce) {
      throw new Error(
        "Quiesced volume backups require a Docker runtime; native Cloud workspaces cannot freeze a service for capture.",
      );
    }
    // Default to /app when sourceId matches DEFAULT_BACKUP_PATH; future
    // producers may pass specific db data paths (e.g. /var/lib/postgresql/data).
    const path = sourceId.startsWith("/") ? sourceId : DEFAULT_BACKUP_PATH;
    const compression = opts?.compression ?? "zstd";
    // Each exclude pattern is shell-escaped: producers (and any future
    // caller) supply these via user-facing UI fields, so an unescaped
    // pattern like `foo; rm -rf /` would inject. shellEscape wraps in
    // single quotes — tar's glob handling is unchanged because it sees
    // the literal pattern bytes after the shell strips quotes.
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => ["--exclude", shellQuote(p)]);
    // Built by the shared helper so tar's exit status cannot hide behind the
    // compressor's — the same masking closed for the DB producers and the Docker volume
    // path. `gzip` needs no pipeline (tar compresses in-process via -z), so it passes
    // "none" and keeps tar's own status directly.
    const tarCmd =
      compression === "gzip"
        ? `tar -cz -C ${shellQuote(path)} ${excludeArgs.join(" ")} .`
        : `tar -c -C ${shellQuote(path)} ${excludeArgs.join(" ")} .`;
    return this.execStream(
      service,
      safeDumpCommand(tarCmd, compression === "zstd" ? "zstd" : "none"),
      { timeoutMs: opts?.timeoutMs, idleTimeoutMs: opts?.idleTimeoutMs },
    );
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    if (!service.containerId) {
      throw new Error(`Cannot restore to cloud service ${service.name}: no workspace id`);
    }
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
    if (!service.containerId) {
      throw new Error(`Cannot exec in cloud service ${service.name}: no workspace id`);
    }
    const ws = this.client.workspace(service.containerId);
    return pipeRestoreCommand(
      {
        run: async (command, options) => {
          const capture = await this.execStream(service, ["sh", "-c", command], options);
          capture.stdout.resume();
          return capture.awaitExit;
        },
        stage: async (localDir, remoteDir, signal) => {
          const rt = await ws.runtime();
          signal.throwIfAborted();
          // The SDK accepts only tar.gz extracted INTO a directory. Stage the
          // original bytes as one private file, regardless of their own codec.
          // Stream the wrapper; the build transfer helper buffers up to 500 MiB.
          const archive = tarFs.pack(localDir, { entries: ["artifact.bin"] });
          const compressed = createGzip();
          const packing = pipeline(archive, compressed, { signal });
          void packing.catch(() => {});
          try {
            const result = await rt.transfer.upload({
              body: Readable.toWeb(compressed),
              dest: remoteDir,
            });
            if (!result.files_extracted) throw new Error("Restore staging extracted no files");
            await packing;
          } finally {
            archive.destroy();
            compressed.destroy();
            await packing.catch(() => {});
          }
        },
      },
      service.name,
      cmd,
      body,
      opts,
    );
  }

  async stopService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) return;
    await this.client.workspaces.stop(service.containerId);
  }

  async startService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) {
      throw new Error(`Cannot start cloud service ${service.name}: no workspace id`);
    }
    await this.client.workspaces.start(service.containerId);
  }

  async isRunning(service: ServiceHandle): Promise<boolean> {
    if (!service.containerId) return false;
    const data = await this.client.workspaces.get(service.containerId);
    return data.status === "running";
  }
}
registerExecutor("cloud", (runtime) => {
  if (!(runtime instanceof CloudRuntime)) {
    throw new Error(
      "CloudBackupExecutor requires a CloudRuntime instance. " +
        `Got: ${(runtime as { name?: string })?.name ?? typeof runtime}`,
    );
  }
  return new CloudBackupExecutor(runtime);
});
