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

import { Transform } from "node:stream";
import type { DockerRuntime } from "./docker";

export interface ImageTransferOptions {
  /** Running total of bytes streamed out of the source (pre-load). */
  onProgress?: (bytesMoved: number) => void;
  log?: (message: string) => void;
}

export interface ImageTransferResult {
  bytesMoved: number;
}

/**
 * Stream an image from `src` daemon to `dst` daemon. Saved BY ID (`image.id`)
 * — reliable even when the tag has drifted — then the original `image.tag` is
 * re-applied on `dst` (a save-by-id load is untagged, and the deploy adopts the
 * tag as its `imageRef`). Throws if the save or load ends non-zero (so a
 * truncated/failed move never looks like success). Returns the byte count.
 */
export async function transferImage(
  src: DockerRuntime,
  dst: DockerRuntime,
  image: { id: string; tag: string },
  opts?: ImageTransferOptions,
): Promise<ImageTransferResult> {
  opts?.log?.(`saving ${image.tag} (${image.id.slice(0, 19)})`);
  const { stdout, awaitExit } = await src.saveImage(image.id);

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
  counter.on("error", () => {});
  // pipe() does not forward source errors — bridge them so `docker load` aborts
  // instead of hanging on a stream that will never complete.
  stdout.on("error", (err) => counter.destroy(err));
  stdout.pipe(counter);

  // load consumes the counted stream; it resolves when the save stream EOFs.
  // It returns the ref the load actually restored under (the config id for a
  // save-by-id tar) — retag from THAT, not `image.id` (often a RepoDigest that
  // doesn't resolve on the target → "No such image").
  const loadedRef = await dst.loadImage(counter);

  const exit = await awaitExit;
  if (exit.code !== 0) {
    throw new Error(
      `Image transfer failed (${image.tag}): ${exit.stderr || `docker save exit ${exit.code}`}`,
    );
  }
  // Re-apply the tag on the target (loaded untagged when saved by id).
  await dst.tagImage(loadedRef ?? image.id, image.tag);
  opts?.log?.(`loaded ${image.tag} — ${bytesMoved} bytes`);
  return { bytesMoved };
}
