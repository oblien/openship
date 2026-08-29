/**
 * Streaming demultiplexer for Docker's multiplexed attach/exec protocol —
 * the one that applies BACKPRESSURE.
 *
 * WHY THIS EXISTS
 * `docker-modem`'s own `demuxStream` is a one-way firehose. Reduced to its two
 * load-bearing lines:
 *
 *     stdout.write(content);          // return value discarded
 *     streama.on('data', processData) // source put in flowing mode, never paused
 *
 * A `write()` that returns `false` means "I have accepted this chunk into memory
 * but you must stop until I drain". Discarding that answer turns every slow
 * consumer into an unbounded heap allocation: the daemon produces at disk/pipe
 * speed (a warm `mysqldump | zstd` does hundreds of MB/s) and the sink drains at
 * network speed, so the difference accumulates in the destination PassThrough's
 * write queue until the process dies. That is
 * [#633](https://github.com/oblien/openship/issues/633) — a ~110 GB MySQL dump to
 * SFTP, `RangeError: Out of memory` inside modem's demuxer at a reproducible ~64s,
 * which is exactly how long ~100 MB/s in against ~1.7 MB/s out takes to eat the
 * heap. The dump size was never the problem; the missing `false` was.
 *
 * So the source is paused while any sink is behind and resumed when every sink has
 * drained. Memory in flight is then bounded by the sinks' own high-water marks
 * instead of by the speed difference, and a slow destination makes a backup SLOW
 * rather than fatal. The bytes ultimately stop at `mysqldump`, which blocks on its
 * own `write(2)` once the daemon stops reading — the correct place for the
 * pressure to land.
 *
 * Two more things fall out of owning the parser, both of which modem gets wrong
 * for a payload we intend to restore from:
 *
 *  - **Desync is fatal, not silent.** Modem routes every frame whose type byte
 *    isn't 1 to stderr, so a parser that has lost frame alignment quietly
 *    *discards* archive bytes and the backup still "succeeds". A stream type
 *    outside {0,1,2} means alignment is already lost, and for a payload someone
 *    intends to restore from, a hard error beats a truncated artifact.
 *  - **No O(n²) reassembly.** Modem does `Buffer.concat([buffer, data])` on every
 *    chunk plus a fresh `Buffer.from(...)` copy per frame, i.e. it recopies its
 *    pending buffer for each arriving chunk. Only the incomplete tail is carried
 *    here, so a whole frame is copied at most once.
 *
 * Callers all run `Tty: false`, which is what makes the output framed at all —
 * with a TTY the daemon sends raw bytes and there is nothing to demux.
 */

import type { Readable, Writable } from "node:stream";

/** Frame header: `[streamType, 0, 0, 0, uint32be payloadLength]`. */
const HEADER_BYTES = 8;

/**
 * Reject a declared payload length this large as desync rather than buffering it.
 *
 * The daemon writes frames bounded by its own copy buffer (tens of KB), so a real
 * frame is orders of magnitude under this. The check matters because the length is
 * a `uint32`: a parser reading a payload byte as a header can be told to wait for
 * ~4 GiB, and "wait for more input" on a stream that has none is indistinguishable
 * from a hang. Bounding it turns that into the error it is.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Docker's stream-type byte: 0 = stdin (echoed), 1 = stdout, 2 = stderr. */
const STREAM_STDIN = 0;
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;

/** A sink plus the "is it behind?" bookkeeping one needs to gate the source. */
interface GatedSink {
  write: (chunk: Buffer) => void;
}

/**
 * Wrap one sink so a `false` from `write()` registers exactly one pending drain.
 *
 * The `blocked` flag is the whole point: a sink that keeps returning `false` for
 * chunk after chunk must not accumulate one `drain` listener per chunk. That would
 * both leak listeners (the ten-listener warning is the visible half) and unbalance
 * the counter — N decrements for the one `drain` that eventually fires — which
 * would resume the source while the sink is still full and reopen the leak this
 * module exists to close.
 */
function gateSink(
  sink: Writable,
  onBlock: () => void,
  onUnblock: () => void,
  onWriteAfterEnd: () => void,
): GatedSink {
  let blocked = false;
  return {
    write(chunk: Buffer): void {
      // Writing to an ended or destroyed sink DISCARDS the bytes. Silently, with no
      // error and no exit code — which for an artifact means a truncated payload
      // recorded as a complete backup, hashed over the bytes that did arrive so even
      // restore-time verification passes. So it is an error, not an early return.
      //
      // A SECOND line of defence, not the primary one. If the demuxer happens to be
      // paused when something ends the sink, it never attempts another write and this
      // never fires — the payload is lost to starvation instead, because Node emits no
      // `'drain'` after `end()` and the source can never be resumed. Whoever ends these
      // sinks must therefore consult `pending()` first; see the backstop in
      // demuxContainerStream, and the 9.1 MB measurement recorded there.
      if (sink.destroyed || sink.writableEnded) return onWriteAfterEnd();
      if (sink.write(chunk) !== false || blocked) return;
      blocked = true;
      onBlock();
      sink.once("drain", () => {
        blocked = false;
        onUnblock();
      });
    },
  };
}

/**
 * Demux `source` into `stdout` / `stderr`, honoring each sink's backpressure.
 *
 * Neither sink is ended — the source's `end`/`close` is the caller's signal to do
 * that, and the two backup call sites both need to reap a helper container at that
 * point.
 *
 * `onError` is not optional decoration: a desync (or a source that dies mid-frame)
 * can be followed by a perfectly normal `end` on the source, and both backup
 * callers learn the exit status from exactly that event. Without a separate channel
 * the run would read the exec's own `0` and record a truncated artifact as a
 * complete backup — the failure mode this whole pass exists to remove. `stdout` is
 * destroyed as well so a consumer already piping the archive stops, but the
 * callback is what must reach the promise the orchestrator awaits.
 */
export interface DemuxHandle {
  /**
   * Is there payload still on its way to the sinks?
   *
   * True while a partial frame is held, while the source has bytes we have not parsed,
   * or while a sink is full (which means more is coming as soon as it drains). A caller
   * that force-ends the sinks — the lost-`end` backstop — must consult this first:
   * ending while this is true strands the tail, and after `end()` Node emits no further
   * `'drain'`, so a paused demuxer can never resume to deliver it.
   */
  pending: () => boolean;
}

export function demuxDockerStream(
  source: Readable | NodeJS.ReadableStream,
  stdout: Writable,
  stderr: Writable,
  onError?: (err: Error) => void,
): DemuxHandle {
  const src = source as Readable;

  let blockedSinks = 0;
  let pausedByUs = false;

  const onBlock = (): void => {
    blockedSinks += 1;
    if (pausedByUs) return;
    pausedByUs = true;
    src.pause();
  };
  const onUnblock = (): void => {
    blockedSinks -= 1;
    if (blockedSinks > 0 || !pausedByUs) return;
    pausedByUs = false;
    src.resume();
  };

  const onWriteAfterEnd = () =>
    fail(
      new Error(
        "Docker stream was ended while payload was still arriving: the sink had already " +
          "closed, so those bytes were dropped. What was written is not a complete " +
          "artifact.",
      ),
    );
  const out = gateSink(stdout, onBlock, onUnblock, onWriteAfterEnd);
  const err = gateSink(stderr, onBlock, onUnblock, onWriteAfterEnd);

  /** The incomplete tail of the previous chunk — never a whole frame. */
  let carry: Buffer | null = null;
  let failed = false;

  const fail = (cause: Error): void => {
    if (failed) return;
    failed = true;
    carry = null;
    src.pause();
    onError?.(cause);
    stdout.destroy(cause);
  };

  src.on("data", (chunk: Buffer) => {
    if (failed) return;

    let buf = carry === null ? chunk : Buffer.concat([carry, chunk]);
    carry = null;
    let offset = 0;

    while (buf.length - offset >= HEADER_BYTES) {
      const type = buf[offset]!;
      const length = buf.readUInt32BE(offset + 4);

      if (type !== STREAM_STDIN && type !== STREAM_STDOUT && type !== STREAM_STDERR) {
        fail(
          new Error(
            `Docker stream desynchronized: frame type ${type} at offset ${offset} is not ` +
              `stdin/stdout/stderr. Refusing to guess where the payload resumes — the bytes ` +
              `already read cannot be trusted as a complete artifact.`,
          ),
        );
        return;
      }
      if (length > MAX_FRAME_BYTES) {
        fail(
          new Error(
            `Docker stream desynchronized: frame claims ${length} bytes, over the ` +
              `${MAX_FRAME_BYTES}-byte sanity ceiling. Treating as a lost frame boundary ` +
              `rather than waiting for input that will never arrive.`,
          ),
        );
        return;
      }
      // Frame straddles the chunk boundary: keep the whole thing (header included)
      // and re-parse once the rest lands.
      if (buf.length - offset - HEADER_BYTES < length) break;

      const payload = buf.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
      // stdin frames are the daemon echoing what we wrote; they are not output.
      if (type === STREAM_STDOUT) out.write(payload);
      else if (type === STREAM_STDERR) err.write(payload);
      offset += HEADER_BYTES + length;
    }

    if (offset < buf.length) {
      // Copy the tail. `subarray` is a view, and keeping a view would pin the
      // entire chunk (and, after a concat, the entire previous carry) alive for
      // the sake of a few trailing bytes.
      carry = Buffer.from(buf.subarray(offset));
    }
  });

  // A source that dies mid-artifact must not look like a clean end to the
  // consumer, which would record a truncated dump as a complete one.
  src.on("error", (cause: Error) => fail(cause));

  // Ending with an incomplete frame still buffered is a definitive truncation: the
  // daemon only ever writes whole frames, so a partial one at EOF means the stream
  // was cut mid-payload. Worth checking precisely because the alternative is
  // invisible — we hash and record whatever arrived, so a short artifact passes its
  // own integrity check at restore time and reads as a smaller database.
  src.on("end", () => {
    if (failed || carry === null) return;
    fail(
      new Error(
        `Docker stream ended mid-frame with ${carry.length} bytes of an incomplete ` +
          `frame buffered. The payload was cut short, so what was read is not a ` +
          `complete artifact.`,
      ),
    );
  });

  return {
    pending: () => carry !== null || src.readableLength > 0 || blockedSinks > 0,
  };
}
