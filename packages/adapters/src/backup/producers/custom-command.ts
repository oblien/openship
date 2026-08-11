/**
 * CustomCommandProducer — power-user escape hatch.
 *
 * Lets users back up shapes the built-in producers don't cover:
 * SQLite (cp app.db), Elasticsearch (snapshot API tar), Cassandra
 * (nodetool snapshot), etc.
 *
 * Policy carries:
 *   produceCommand   shell command whose stdout IS the artifact.
 *                    Compression is the user's responsibility.
 *   restoreCommand   shell command whose stdin receives the artifact.
 *                    Should be inverse of produceCommand.
 *   artifactName     filename portion of the destination key (default
 *                    `custom-backup.bin`).
 *
 * Detection: never auto-matches — selected only when policy.payloadKind
 * is explicitly "custom_command".
 */

import { registerProducer } from "../registry";
import type {
  Artifact,
  ArtifactRef,
  BackupExecutor,
  BackupProducer,
  ProducerOpts,
  RestoreOpts,
  ServiceHandle,
} from "../types";

class CustomCommandProducerImpl implements BackupProducer {
  readonly kind = "custom_command" as const;

  // No detect — explicit selection only.

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    // Read straight off `opts` — the keys are declared on ProducerOpts. The cast
    // that used to sit here is what let the orchestrator drop all three of them
    // (D5) without a type error.
    const produceCommand = opts.produceCommand ?? opts.command;
    if (!produceCommand) {
      throw new Error("custom_command producer requires `produceCommand` in policy payload config");
    }

    const { stdout, awaitExit } = await executor.execStream(service, [
      "sh",
      "-c",
      produceCommand,
    ]);

    yield {
      name: opts.artifactName ?? "custom-backup.bin",
      stream: stdout,
      payloadKind: "custom_command",
      metadata: {
        produceCommand,
        // The ONLY record of how to put this artifact back. Nothing downstream
        // can reconstruct it, which is why losing it here made every captured
        // run unrestorable.
        restoreCommand: opts.restoreCommand ?? null,
      },
    };

    const exit = await awaitExit;
    if (exit.code !== 0) {
      throw new Error(
        `custom produceCommand exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    _opts: RestoreOpts,
  ): Promise<void> {
    const restoreCommand =
      (artifact.metadata.restoreCommand as string | null) ?? null;
    if (!restoreCommand) {
      throw new Error(
        "Backup has no restoreCommand recorded — restore is not possible for this artifact. " +
          "Re-run the backup policy to capture a restorable one.",
      );
    }

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(
      service,
      ["sh", "-c", restoreCommand],
      body,
      { timeoutMs: 60 * 60 * 1000 },
    );
    if (exit.code !== 0) {
      throw new Error(
        `custom restoreCommand exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    }
  }
}

export const CustomCommandProducer = new CustomCommandProducerImpl();
registerProducer(CustomCommandProducer);
