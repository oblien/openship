/**
 * image-transfer — move ONE built image between two Docker daemons as pure
 * data: `docker save` on the source → a byte-counting passthrough → `docker
 * load` on the target. The image half of a cross-server migration (volumes go
 * through volume-transfer.ts), so a locally-built stack moves with no registry,
 * no repo, and no rebuild — the target adopts the exact same image.
 *
 * The bytes stream source → API host (as a backpressured pipe, never staged to
 * disk) → target, mirroring how the volume stream relays. Progress is reported
 * per chunk via onProgress (throttle at the caller before it hits the wire).
 *
 * No extra compression: `docker save` layers are already gzip-compressed.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Transform } from "node:stream";
import type { DockerRuntime } from "./docker";

export interface ImageTransferOptions {
  /** Running total of bytes streamed out of the source (pre-load). */
  onProgress?: (bytesMoved: number) => void;
  log?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ImageTransferResult {
  bytesMoved: number;
  /** Reference that resolves on the target daemon, suitable for artifact handover. */
  imageRef: string;
}

/** Digest references cannot be Docker tag targets, and save/load may restore a
 * different (config) ID. Both transfer transports use the loader's actual ref. */
export function resolveTransferredImageRef(
  requested: string,
  loaded?: string,
): string {
  if (!requested.includes("@") && !/^sha256:[a-f0-9]+$/i.test(requested))
    return requested;
  if (!loaded?.trim())
    throw new Error(
      "Docker load did not report a usable image reference for the transferred digest",
    );
  return loaded.trim();
}

/**
 * Stream an image from `src` daemon to `dst` daemon. Saved BY ID (`image.id`)
 * — reliable even when the tag has drifted — then the original `image.tag` is
 * re-applied on `dst` (a save-by-id load is untagged, and the deploy adopts the
 * tag as its `imageRef`). Digest inputs instead return the loaded reference;
 * Docker cannot recreate a repository digest with `tag`. Throws if the save or
 * load ends non-zero. Returns the byte count and usable target reference.
 */
export async function transferImage(
  src: DockerRuntime,
  dst: DockerRuntime,
  image: { id: string; tag: string },
  opts?: ImageTransferOptions,
): Promise<ImageTransferResult> {
  opts?.signal?.throwIfAborted();
  opts?.log?.(`saving ${image.tag} (${image.id.slice(0, 19)})`);
  const { stdout, awaitExit } = await src.saveImage(image.id);
  void awaitExit.catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "adapters/runtime/image-transfer");
  });

  let bytesMoved = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesMoved += chunk.length;
      opts?.onProgress?.(bytesMoved);
      cb(null, chunk);
    },
  });
  // `counter`'s real consumer + error handling attach inside dst.loadImage below,
  // but only AFTER an SSH connect handshake. Floor 'error' on counter first so a
  // source failure during that window (which triggers counter.destroy(err) via the
  // bridge below) isn't an unhandled 'error' event that crashes the process. The
  // destroy still tears the stream down, so `docker load` aborts non-zero as intended.
  counter.on("error", (eventDiagnosticError) => { observeCaughtError(eventDiagnosticError, "adapters/runtime/image-transfer"); });
  // pipe() does not forward source errors — bridge them so `docker load` aborts
  // instead of hanging on a stream that will never complete.
  stdout.on("error", (err) => { observeCaughtError(err, "adapters/runtime/image-transfer"); return counter.destroy(err); });
  stdout.pipe(counter);
  const abort = () => {
    counter.destroy(new Error("Image transfer cancelled"));
    stdout.destroy();
  };
  opts?.signal?.addEventListener("abort", abort, { once: true });
  if (opts?.signal?.aborted) abort();

  // load consumes the counted stream; it resolves when the save stream EOFs.
  // It returns the ref the load actually restored under (the config id for a
  // save-by-id tar) — retag from THAT, not `image.id` (often a RepoDigest that
  // doesn't resolve on the target → "No such image").
  try {
  const loadedRef = await dst.loadImage(counter);

  const exit = await awaitExit;
  if (exit.code !== 0) {
    throw new Error(
      `Image transfer failed (${image.tag}): ${exit.stderr || `docker save exit ${exit.code}`}`,
    );
  }
  const imageRef = resolveTransferredImageRef(image.tag, loadedRef);
  // Re-apply names, but never try to manufacture a repository digest with tag.
  if ((loadedRef ?? image.id) !== imageRef) await dst.tagImage(loadedRef ?? image.id, imageRef);
  opts?.log?.(`loaded ${image.tag} — ${bytesMoved} bytes`);
  return { bytesMoved, imageRef };
  } finally {
    opts?.signal?.removeEventListener("abort", abort);
    counter.destroy();
    stdout.destroy();
  }
}
