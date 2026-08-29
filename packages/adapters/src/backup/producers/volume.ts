/**
 * VolumeCopyProducer — the universal fallback. Tars every backupable
 * volume (named + bind) into one artifact per volume.
 *
 * For services without a specialized DB producer, this is what runs. Crash-consistent
 * by default — the service keeps running during the copy, so the bytes are whatever the
 * filesystem looked like across the walk, not at one instant. Pass `quiesce` to freeze
 * the container for the duration and get a point-in-time archive instead; the artifact
 * records which one it is under `metadata.consistency`.
 *
 * Restore = receiveStream into the same volume id. Producer-side
 * decisions: clear the target before extracting (assumes the user
 * intends a full replace, not a merge), wait for the service to
 * report running again after the parent orchestrator restarts it.
 */

import type { Readable } from "node:stream";
import { recordedCodec } from "../common/dump-pipeline";
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
      // Used to `return` here, which the orchestrator recorded as a SUCCESSFUL
      // zero-artifact run — a nightly schedule reporting green while backing up
      // nothing at all (#611). "Nothing to back up" is not a successful backup; it
      // means we could not find the data, and the operator has to hear that.
      //
      // The container id is in the message because it is the whole diagnosis. With
      // one, the live container was inspected and genuinely has no volume or bind
      // mounts. Without one, we only ever saw the service row's `volumes` column,
      // which is empty for services Openship adopted rather than deployed (the
      // control plane's own compose stack is the reported case: its rows are
      // created from running containers and carry no volume specs).
      throw new Error(
        `Nothing to back up: no volumes or bind mounts found for service "${service.name}". ` +
          (service.containerId
            ? `Its live container (${service.containerId.slice(0, 12)}) reports no volume or bind ` +
              `mounts, so there is no persistent data here to capture.`
            : `No container was resolved for it, so only the service's recorded volumes could be ` +
              `checked and it has none. If this service does hold data, redeploy it so Openship ` +
              `records its volumes, or point the policy at a database payload instead of a volume ` +
              `snapshot.`),
      );
    }

    const selected = opts.sourceIds && opts.sourceIds.length > 0
      ? sources.filter((s) => opts.sourceIds!.includes(s.id))
      : sources.filter((s) => s.type !== "tmpfs");

    // Every candidate filtered out is the same failure one step later: an explicit
    // `sourceIds` that matches nothing, or a service whose only mounts are tmpfs
    // (never backupable — the data is gone when the container stops).
    if (selected.length === 0) {
      const available = sources.map((s) => `${s.id} (${s.type})`).join(", ");
      throw new Error(
        `Nothing to back up for service "${service.name}": ` +
          (opts.sourceIds && opts.sourceIds.length > 0
            ? `the policy selects ${opts.sourceIds.join(", ")}, none of which is a source on this ` +
              `service. Available: ${available}.`
            : `its only mounts are tmpfs, which hold no data across a restart. Found: ${available}.`),
      );
    }

    for (const source of selected) {
      // zstd unless told otherwise: best ratio, and what every existing artifact used. The
      // knob matters because zstd is apk-installed into the helper at runtime, so the
      // default needs egress — see ProducerOpts.compression.
      const compression = opts.compression ?? "zstd";
      const { stdout, awaitExit } = await executor.streamPath(service, source.id, {
        compression,
        exclude: opts.exclude,
        quiesce: opts.quiesce,
      });

      // The artifact stream is the executor's stdout. The orchestrator
      // pipes it onward + tracks any awaitExit failures.
      yield {
        name: `volume-${sanitizeArtifactName(source.id)}.tar${
          compression === "zstd" ? ".zst" : compression === "gzip" ? ".gz" : ""
        }`,
        stream: stdout as unknown as Readable,
        payloadKind: "volume",
        sizeHint: source.sizeHint,
        metadata: {
          volumeId: source.id,
          volumeSource: source.source,
          volumeTarget: source.target,
          volumeType: source.type,
          compression,
          // Recorded so the artifact says what it IS, rather than leaving an operator to
          // assume. `crash` means the service kept writing while tar walked the tree —
          // usable for most payloads, and the reason a database deserves a logical dump
          // instead. `quiesced` means the container was frozen for the copy.
          consistency: opts.quiesce ? "quiesced" : "crash",
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
      // Through the recorded-codec reader rather than a cast: the cast trusted jsonb to
      // hold one of three strings, and anything else (a typo in a hand-written policy,
      // a value from a newer build) reached the restore helper as a codec it cannot
      // build a pipeline for. `recordedCodec` maps the unknown to `zstd` — the only
      // safe guess, and for the same documented reason.
      compression: recordedCodec(artifact.metadata.compression),
      clearTarget: opts.clearTarget ?? true,
      signal: opts.signal,
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
