/**
 * Live byte progress for a streaming upload.
 *
 * `summary()` answers only after EOF — useless while a multi-GB artifact is
 * still moving. `onBytes` fires per chunk with the CUMULATIVE count, so the
 * backup orchestrator can persist + broadcast progress mid-stream (throttling
 * is the caller's job — this stream must not know about databases or buses).
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";

import { HashingPassthrough } from "../src/backup/common/sha256-stream";

const drain = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

describe("HashingPassthrough onBytes", () => {
  it("reports the cumulative byte count on every chunk", async () => {
    const seen: number[] = [];
    const hasher = new HashingPassthrough({ onBytes: (n) => seen.push(n) });

    await pipeline(
      Readable.from([Buffer.alloc(100), Buffer.alloc(5), Buffer.alloc(1000)]),
      hasher,
      drain(),
    );

    expect(seen).toEqual([100, 105, 1105]);
    expect(hasher.summary().bytesWritten).toBe(1105);
  });

  it("stays silent for a zero-byte stream and still summarizes", async () => {
    const onBytes = vi.fn();
    const hasher = new HashingPassthrough({ onBytes });

    await pipeline(Readable.from([]), hasher, drain());

    expect(onBytes).not.toHaveBeenCalled();
    expect(hasher.summary().bytesWritten).toBe(0);
  });

  it("is optional — a bare instance hashes exactly as before", async () => {
    const hasher = new HashingPassthrough();

    await pipeline(Readable.from([Buffer.from("abc")]), hasher, drain());

    expect(hasher.summary()).toEqual({
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytesWritten: 3,
    });
  });
});
