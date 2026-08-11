/**
 * VolumeCopyProducer — the universal fallback. Tars every backupable
 * volume (named + bind) into one artifact per volume.
 *
 * For services without specialized DB producers (postgres/mysql/redis/
 * mongo come in Chunk 3), this is what runs. Crash-consistent — the
 * service keeps running during the snapshot; the bytes are whatever
 * the filesystem looks like at that moment.
 *
 * Restore = receiveStream into the same volume id. Producer-side
 * decisions: clear the target before extracting (assumes the user
 * intends a full replace, not a merge), wait for the service to
 * report running again after the parent orchestrator restarts it.
 */

import type { Readable } from "node:stream";
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

class VolumeCopyProducerImpl implements BackupProducer {
  readonly kind = "volume" as const;

  // No detects() — this producer is the registry's fallback when
  // nothing else matches, picked explicitly by resolveProducerForService.

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    const sources = await executor.listSources(service);
    if (sources.length === 0) {
      // No volumes = nothing to back up. Return an empty manifest —
      // the orchestrator records this as a successful zero-artifact run.
      return;
    }

    const selected = opts.sourceIds && opts.sourceIds.length > 0
      ? sources.filter((s) => opts.sourceIds!.includes(s.id))
      : sources.filter((s) => s.type !== "tmpfs");

    for (const source of selected) {
      const { stdout, awaitExit } = await executor.streamPath(service, source.id, {
        compression: "zstd",
        exclude: opts.exclude,
      });

      // The artifact stream is the executor's stdout. The orchestrator
      // pipes it onward + tracks any awaitExit failures.
      yield {
        name: `volume-${sanitizeArtifactName(source.id)}.tar.zst`,
        stream: stdout as unknown as Readable,
        payloadKind: "volume",
        sizeHint: source.sizeHint,
        metadata: {
          volumeId: source.id,
          volumeSource: source.source,
          volumeTarget: source.target,
          volumeType: source.type,
          compression: "zstd",
        },
      };

      // After the orchestrator finishes consuming the stream, the
      // helper container exits. If it exited non-zero, surface the
      // error here — the orchestrator awaits this side too via the
      // artifact stream's `end` event.
      const exit = await awaitExit;
      if (exit.code !== 0) {
        throw new Error(
          `tar exited ${exit.code} while backing up ${source.id}: ${exit.stderr.slice(0, 500)}`,
        );
      }
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    opts: RestoreOpts,
  ): Promise<void> {
    const volumeId =
      typeof artifact.metadata.volumeId === "string"
        ? (artifact.metadata.volumeId as string)
        : null;
    if (!volumeId) {
      throw new Error(
        `Artifact ${artifact.key} cannot restore: metadata.volumeId missing. ` +
          `This artifact may have been produced by a different producer.`,
      );
    }
    const stream = await artifact.open();
    await executor.receiveStream(service, volumeId, stream, {
      compression: (artifact.metadata.compression as "zstd" | "gzip" | "none") ?? "zstd",
      clearTarget: opts.clearTarget ?? true,
    });
  }
}

function sanitizeArtifactName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

export const VolumeCopyProducer = new VolumeCopyProducerImpl();

// Self-registration. Producers are picked in registration order, so
// VolumeCopyProducer is registered FIRST as the fallback. DB-specific
// producers in Chunk 3 register before it via the registry's
// "registration order = detect priority" rule — they'll need to call
// registerProducer before this module's index.ts seeds the fallback.
registerProducer(VolumeCopyProducer);
