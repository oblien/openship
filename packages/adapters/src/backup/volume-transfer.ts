/**
 * volume-transfer — THE single, strategy-driven entry point for moving one
 * volume's bytes into another, shared by same-server and cross-server Docker
 * migration (and available to any volume→volume move). It composes the existing
 * backup-executor primitives (`streamPath` / `receiveStream`) plus the
 * same-daemon `copyVolumeLocal`; there is exactly ONE place that decides the
 * mechanism, so callers never duplicate the pipe.
 *
 * Modes (see `resolvePlan`):
 *   - "direct" — one helper mounts BOTH volumes on the same daemon (no SSH hop,
 *     no compression). Fastest when source and target share a daemon.
 *   - "stream" — `streamPath` → `receiveStream`, works across daemons/hosts.
 *   - "rsync"  — reserved; not yet implemented, falls back to "stream" (logged).
 *   - "auto"   — direct when same-daemon + supported, else stream.
 *
 * Compression is chosen for the link, not hard-coded: none on the same daemon
 * (nothing crosses a wire), gzip cross-host by default (busybox built-in, works
 * offline, zero dependency). zstd is honored only when explicitly requested
 * (it needs the helper to fetch zstd, i.e. egress) — never auto-selected, so
 * the zero-dependency guarantee holds.
 *
 * Security: no untrusted value is interpolated into a shell string here —
 * `direct` mounts volumes at fixed paths (docker API), `stream` reuses the
 * executor primitives that shell-escape their own args.
 */

import { Transform } from "node:stream";
import type { BackupExecutor, ServiceHandle } from "./types";

export type TransferMode = "auto" | "stream" | "direct" | "rsync";
export type TransferCompression = "auto" | "zstd" | "gzip" | "none";

/** One end of a transfer: which executor/daemon, which service, which source id. */
export interface TransferEndpoint {
  exec: BackupExecutor;
  handle: ServiceHandle;
  sourceId: string;
}

export interface TransferOptions {
  /** Requested mode. Default "auto". */
  mode?: TransferMode;
  /** Requested compression. Default "auto" (topology-aware). */
  compression?: TransferCompression;
  /** Clear the target before writing (default true — a copy, not a merge). */
  clearTarget?: boolean;
  /** Optional progress/decision log sink (e.g. the orchestrator's run log). */
  log?: (message: string) => void;
  /** Running byte count as data streams (stream mode only — the direct
   *  same-daemon copy reports its total once at the end). */
  onProgress?: (bytesMoved: number) => void;
}

export interface TransferPlan {
  mode: "direct" | "stream";
  compression: "zstd" | "gzip" | "none";
  /** Set when the requested mode/compression was adjusted (e.g. rsync→stream). */
  note?: string;
}

export interface TransferResult {
  bytesMoved: number;
  strategy: "direct" | "stream";
  compression: "zstd" | "gzip" | "none";
}

/** Same daemon iff both ends share the exact executor instance (one connection,
 *  one docker socket). Reference identity is deliberate — a cross-server move
 *  always builds two distinct executors. */
function isSameDaemon(src: TransferEndpoint, dst: TransferEndpoint): boolean {
  return src.exec === dst.exec;
}

function directSupported(src: TransferEndpoint, dst: TransferEndpoint): boolean {
  return isSameDaemon(src, dst) && typeof src.exec.copyVolumeLocal === "function";
}

/**
 * Pure decision function (unit-testable, no IO): given the endpoints + request,
 * resolve the concrete mechanism + compression. Never silently downgrades
 * without recording a `note`.
 */
export function resolvePlan(
  src: TransferEndpoint,
  dst: TransferEndpoint,
  opts?: TransferOptions,
): TransferPlan {
  const sameDaemon = isSameDaemon(src, dst);
  const requested: TransferMode = opts?.mode ?? "auto";

  let mode: "direct" | "stream";
  let note: string | undefined;

  switch (requested) {
    case "direct":
      if (directSupported(src, dst)) {
        mode = "direct";
      } else {
        mode = "stream";
        note = "direct requested but not applicable (cross-daemon or unsupported) → stream";
      }
      break;
    case "rsync":
      // Reserved: full delta/resumable rsync is a fast-follow. Fall back safely.
      mode = "stream";
      note = "rsync not yet available → stream";
      break;
    case "stream":
      mode = "stream";
      break;
    case "auto":
    default:
      mode = directSupported(src, dst) ? "direct" : "stream";
      break;
  }

  let compression: "zstd" | "gzip" | "none";
  const reqComp: TransferCompression = opts?.compression ?? "auto";
  if (mode === "direct") {
    compression = "none"; // in-daemon copy never crosses a wire
  } else if (reqComp === "auto") {
    compression = sameDaemon ? "none" : "gzip";
  } else {
    // Honor an explicit choice. zstd needs egress to fetch the codec; that's the
    // caller's opt-in, so we don't second-guess it here.
    compression = reqComp;
  }

  return { mode, compression, note };
}

/**
 * Move one volume's data src → dst using the resolved plan. Returns bytes moved
 * and the strategy actually used (for the run report).
 */
export async function transferVolume(
  src: TransferEndpoint,
  dst: TransferEndpoint,
  opts?: TransferOptions,
): Promise<TransferResult> {
  const plan = resolvePlan(src, dst, opts);
  if (plan.note) opts?.log?.(plan.note);
  const clearTarget = opts?.clearTarget ?? true;

  if (plan.mode === "direct") {
    // directSupported guaranteed copyVolumeLocal exists.
    const { bytesWritten } = await src.exec.copyVolumeLocal!(
      src.handle,
      src.sourceId,
      dst.handle,
      dst.sourceId,
      { clearTarget },
    );
    opts?.onProgress?.(bytesWritten);
    return { bytesMoved: bytesWritten, strategy: "direct", compression: "none" };
  }

  // stream: tar out of the source helper → into the target helper. Works within
  // one daemon or across two (src.exec / dst.exec may differ).
  const read = await src.exec.streamPath(src.handle, src.sourceId, {
    compression: plan.compression,
  });
  let source = read.stdout;
  if (opts?.onProgress) {
    let moved = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        moved += chunk.length;
        opts.onProgress!(moved);
        cb(null, chunk);
      },
    });
    read.stdout.on("error", (err) => counter.destroy(err));
    source = read.stdout.pipe(counter);
  }
  const { bytesWritten } = await dst.exec.receiveStream(dst.handle, dst.sourceId, source, {
    compression: plan.compression,
    clearTarget,
  });
  const exit = await read.awaitExit;
  if (exit.code !== 0) {
    throw new Error(
      `Volume transfer failed (${src.sourceId}): ${exit.stderr || `exit ${exit.code}`}`,
    );
  }
  return { bytesMoved: bytesWritten, strategy: "stream", compression: plan.compression };
}
