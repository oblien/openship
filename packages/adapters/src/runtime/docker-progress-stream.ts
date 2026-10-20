import { PassThrough, type Readable } from "node:stream";

/**
 * Docker Engine 29 inserts NUL bytes between JSON messages on streaming
 * endpoints (`/build`, `/images/create`, `/images/{name}/push`). dockerode's
 * `followProgress` does `JSON.parse` on each line and, on a throw, never
 * advances its buffer — so one NUL stalls the stream forever. The daemon can
 * finish and tag the image while the client sits until the idle timeout.
 *
 * Strip the NULs before that parser sees the bytes. The payload is
 * newline-delimited JSON, so a NUL is never a meaningful character.
 */
export function stripNullBytesFromDockerStream(source: Readable): Readable {
  const cleaned = new PassThrough();
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    cleaned.end();
  };

  source.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cleaned.write(text.includes("\u0000") ? text.replaceAll("\u0000", "") : text);
  });
  source.on("end", finish);
  source.on("close", finish);
  source.on("error", (error: Error) => {
    if (ended) return;
    ended = true;
    // A caller that already destroyed the source (idle timeout, cancel) may have
    // no listener on this side. Forward the error only when someone is waiting
    // for it; otherwise destroy quietly so the timeout path stays the one error.
    if (cleaned.listenerCount("error") > 0) cleaned.destroy(error);
    else cleaned.destroy();
  });
  return cleaned;
}
