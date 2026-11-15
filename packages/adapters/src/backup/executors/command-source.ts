import type { Readable } from "node:stream";
import { shellQuote, withTimeout } from "@repo/core";
import type { CommandExecutor } from "../../types";
import type {
  BackupExecutor,
  BackupSource,
  ExecuteCommandOpts,
  ExecExitInfo,
  ServiceHandle,
  StreamPathOpts,
} from "../types";
import { backupShellCommand } from "../common/command-restore";
import { captureCommandOutput } from "../common/command-stream";

/** A source container reached through a command transport (for example a PaaS
 * SSH relay). It grants no host filesystem, Docker socket, or restore access.
 * Payload formats, stream bounds and command quoting stay in the backup core. */
export class CommandSourceBackupExecutor implements BackupExecutor {
  readonly runtimeName = "bare" as const;
  readonly supportsOfflineVolumeRestore = false;
  constructor(
    private readonly executor: CommandExecutor,
    private readonly paths: readonly string[],
    private readonly signal?: AbortSignal,
    private readonly environment: Record<string, string> = {},
  ) {}
  async listSources(): Promise<BackupSource[]> {
    return this.paths.map((path) => ({ id: path, target: path, source: path, type: "bind" }));
  }
  async execStream(
    _service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    const signal = opts?.signal ?? this.signal;
    signal?.throwIfAborted();
    if (!this.executor.rawExec) throw new Error("This source does not support streaming commands");
    let abandoned = false;
    let opened: Awaited<ReturnType<NonNullable<CommandExecutor["rawExec"]>>> | undefined;
    const opening = this.executor
      .rawExec(backupShellCommand(cmd, { ...opts, env: { ...this.environment, ...opts?.env } }))
      .then((child) => {
        opened = child;
        if (abandoned) child.kill();
        return child;
      });
    try {
      const child = await withTimeout(
        opening,
        30_000,
        "The source did not open its export command within 30 seconds",
        signal,
      );
      return captureCommandOutput(child, { ...opts, signal });
    } catch (error) {
      abandoned = true;
      opened?.kill();
      throw error;
    }
  }
  async streamPath(service: ServiceHandle, sourceId: string, opts?: StreamPathOpts) {
    if (!this.paths.includes(sourceId)) throw new Error("This directory is not an imported volume");
    if (opts?.quiesce) throw new Error("Pause writes at the provider before exporting files");
    if (opts?.compression && opts.compression !== "none" && opts.compression !== "gzip")
      throw new Error("This source supports plain tar or gzip");
    return this.execStream(
      service,
      [
        "sh",
        "-c",
        `tar ${opts?.compression === "gzip" ? "-czf" : "-cf"} - -C ${shellQuote(sourceId)} .`,
      ],
      opts,
    );
  }
  async receiveStream(): Promise<never> {
    throw new Error("This migration connection is read only");
  }
  async pipeIntoCommand(): Promise<never> {
    throw new Error("This migration connection is read only");
  }
  async stopService(): Promise<never> {
    throw new Error("Pause the source at its provider");
  }
  async startService(): Promise<never> {
    throw new Error("Manage the source at its provider");
  }
  async isRunning() {
    return true;
  }
}
