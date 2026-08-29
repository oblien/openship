/**
 * The destination end of #516.
 *
 * `attachDemuxed` leaving stdout un-ended is the root cause of the "stuck in
 * uploading" run (see backup-exec-stream-timeout.test.ts), but the destination
 * had no bound of its own: whatever the reason bytes stopped, `put` waited on a
 * write stream that would never close and never error, holding the run and the
 * worker slot forever. These tests pin both halves of the bound — that a wedged
 * upload fails, and that the bound is not tight enough to kill a live one.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drive } from "./helpers/docker-helper-harness";

/**
 * The SFTP write stream, scriptable as "accepts bytes" or "wedged".
 *
 * `bytesWritten` is named after ssh2's own WriteStream field, which it sets in the
 * constructor and advances only in the `sftp.write` CALLBACK — i.e. once the server
 * has acknowledged the write. `put` reads that field rather than counting bytes off
 * the source stream, because a full write buffer accepts bytes from a fast producer
 * long after the destination has stopped storing them, and the stall watchdog would
 * read that as progress.
 */
class FakeWriteStream extends EventEmitter {
  bytesWritten = 0;
  destroyedWith = false;
  /** When false, write() applies backpressure and 'drain' never comes. */
  accepting = true;

  /**
   * Accepts the chunk now, counts it LATER — ssh2 advances `bytesWritten` only in the
   * `sftp.write` callback, once the server has acknowledged. The delay is the whole
   * point of the fake: a version that counted synchronously could not tell "handed to
   * the write buffer" from "stored on the far end", which is exactly the conflation
   * `put`'s stall watchdog used to make.
   */
  write(chunk: Buffer): boolean {
    if (!this.accepting) return false;
    queueMicrotask(() => {
      this.bytesWritten += chunk.byteLength;
    });
    return true;
  }
  end() {
    queueMicrotask(() => this.emit("close"));
  }
  destroy() {
    this.destroyedWith = true;
    return this;
  }
}

let ws: FakeWriteStream;

vi.mock("ssh2", () => {
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  class FakeClient extends EE {
    connect() {
      queueMicrotask(() => this.emit("ready"));
      return this;
    }
    sftp(cb: (err: Error | null, sftp: unknown) => void) {
      cb(null, {
        createWriteStream: () => ws,
        mkdir: (_p: string, done: (e: Error | null) => void) => queueMicrotask(() => done(null)),
        stat: (_p: string, done: (e: Error | null) => void) => queueMicrotask(() => done(null)),
        rename: (_a: string, _b: string, done: (e: Error | null) => void) =>
          queueMicrotask(() => done(null)),
      });
      return this;
    }
    end() {
      this.emit("close");
    }
  }
  return { Client: FakeClient };
});

// Imported after the mock so the destination's `new Client()` is the fake.
const { resolveDestination } = await import("../src/backup/registry");
await import("../src/backup/destinations/sftp");

function destination() {
  return resolveDestination({
    id: "dst_1",
    name: "backups",
    kind: "sftp",
    sshHost: "backup.example.com",
    sshPort: 22,
    sshUser: "openship",
    // Values without the `enc1:` envelope decrypt verbatim, so no key needed.
    sftpPasswordEnc: "pw",
    pathPrefix: "/srv/backups",
  } as Parameters<typeof resolveDestination>[0]);
}

beforeEach(() => {
  vi.useFakeTimers();
  ws = new FakeWriteStream();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SFTP upload silence is bounded, slowness is not", () => {
  it("fails a wedged upload instead of waiting on a write stream that never closes", async () => {
    const body = new PassThrough();
    // Bytes land, then the stream stops accepting and never drains — the shape of
    // the production stall, whatever its cause.
    body.write(Buffer.alloc(1024, 1));
    ws.accepting = false;
    body.write(Buffer.alloc(4096, 1));

    const put = destination().put("shop/db/run_1/pg-dump.zst", body, {});
    const failure = expect(drive(put, 12 * 60_000, 5_000)).rejects;

    await failure.toThrow(/SFTP upload stalled: no write progress for 600s/);
    expect(ws.destroyedWith).toBe(true);
  });

  it("lets an upload whose source goes quiet inside execStream's idle budget finish", async () => {
    const body = new PassThrough();
    const put = destination().put("shop/db/run_1/pg-dump.zst", body, {});

    // 9 minutes of silence: a pg_dump on a lock wait or a cold table scan is
    // still healthy here — execStream allows it 10 minutes before abandoning it,
    // and this destination must not be the one to give up first.
    body.write(Buffer.alloc(512, 1));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    body.write(Buffer.alloc(512, 1));
    body.end();

    await expect(drive(put, 60_000)).resolves.toMatchObject({ bytesWritten: 1024 });
    expect(ws.bytesWritten).toBe(1024);
    expect(ws.destroyedWith).toBe(false);
  });
});
