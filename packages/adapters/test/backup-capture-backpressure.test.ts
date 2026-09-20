/**
 * #633, end to end, through the REAL transport.
 *
 * Every other test in this area proves a component: the demuxer pauses its source,
 * the executor asks for a socket. This one proves the property the issue is actually
 * about — that a slow destination stops the DAEMON — by standing up a fake daemon on
 * a real TCP port, speaking the real `101 UPGRADED` handshake, streaming real
 * multiplexed frames as fast as the socket will take them, and then asserting the
 * fake daemon *cannot keep writing* while the destination is blocked.
 *
 * It is worth the setup because the fix has a failure mode that every component test
 * passes: `demuxDockerStream` faithfully calls `pause()`, and on the wrong transport
 * `pause()` does nothing. Measured on Bun 1.3.1, pausing an `http.IncomingMessage` —
 * which is exactly what dockerode's non-hijack `exec.start()`/`attach()` resolve to —
 * let a peer push 2 GB while the consumer had seen 0.1 MB. So the assertion here is
 * deliberately made against the SERVER's byte counter, not against anything on the
 * client: "did the producer stop" is the question, and the client cannot answer it.
 *
 * Runs under vitest (Node) in CI, and it is written to pass under Bun too — verified
 * green on Bun 1.3.1, which matters more than the Node run: Bun is what the api ships
 * as, and Bun's stream semantics are the entire reason this file exists. Re-run it
 * there whenever this path changes:
 *   bun test packages/adapters/test/backup-capture-backpressure.test.ts
 *
 * (If it ever fails there with "a beforeEach/afterEach hook timed out", that is the
 * teardown, not the assertions — `server.close()` waits for the connection whose peer
 * we deliberately paused. `fakeDaemon.close()` destroys tracked sockets first for
 * exactly that reason.)
 */

import net from "node:net";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startAttachStream } from "../src/runtime/docker-exec-stream";
import { demuxDockerStream } from "../src/runtime/docker-demux";

/** One Docker multiplexed stdout frame. */
function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const PAYLOAD = Buffer.alloc(64 * 1024, 0x61);
const CHUNK = frame(PAYLOAD);
/** More than any buffer in the chain, so "it all fit" is not an explanation. */
const TOTAL_TO_PUSH = 256 * 1024 * 1024;

interface FakeDaemon {
  port: number;
  /** Frame bytes handed to the socket so far — the producer's own view. */
  pushed: () => number;
  close: () => Promise<void>;
}

/**
 * A daemon that answers the upgrade and then writes frames until the socket refuses.
 *
 * `pushed` counts only what `socket.write()` accepted, and the pump stops on a false
 * return — i.e. it is a well-behaved producer, exactly like dockerode's daemon. If the
 * consumer's backpressure is real, this number plateaus.
 */
async function fakeDaemon(totalToPush = TOTAL_TO_PUSH): Promise<FakeDaemon> {
  let pushed = 0;
  // Tracked so teardown can destroy them explicitly. `server.close()` only stops
  // accepting — it waits for open connections, and a connection whose peer we paused
  // on purpose is exactly the one that will not close itself. Under Bun that turned
  // into an afterEach hook timeout that reads like a failing assertion.
  const live = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n",
      );
      const pump = () => {
        while (pushed < totalToPush) {
          pushed += CHUNK.length;
          if (!socket.write(CHUNK)) return void socket.once("drain", pump);
        }
        socket.end();
      };
      pump();
    });
    socket.on("error", () => {}); // the client hangs up first; not interesting
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    pushed: () => pushed,
    close: async () => {
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A destination that accepts one write and then never drains — a wedged upload. */
function blockedDestination(): Writable & { accepted: () => number } {
  let accepted = 0;
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _enc, _cb) {
      accepted += chunk.byteLength;
      // Deliberately never call cb(): this is the slow-destination case, and the
      // callback is what would eventually produce a 'drain'.
    },
  }) as Writable & { accepted: () => number };
  sink.accepted = () => accepted;
  return sink;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

describe("a blocked destination stops the daemon", () => {
  it("plateaus the producer instead of buffering the whole stream in the API", async () => {
    daemon = await fakeDaemon();
    const stream = await startAttachStream({ host: "127.0.0.1", port: daemon.port }, "helper_1", {
      stdin: false,
      stdout: true,
      stderr: true,
    });

    const sink = blockedDestination();
    const discard = new Writable({ write: (_c, _e, cb) => cb() });
    demuxDockerStream(stream, sink, discard);

    try {
      await sleep(600);
      const early = daemon.pushed();
      await sleep(900);
      const late = daemon.pushed();

      // The property: the producer is STUCK. Not "the client stopped reporting" —
      // the daemon itself can no longer place bytes on the wire.
      expect(late).toBe(early);

      // And it stopped early. Generous ceiling: the socket's own send/receive buffers
      // plus the bridge's and the sink's are all legitimately in flight, but that is
      // single-digit MB, nowhere near the 256 MB on offer. Before the fix this was
      // the entire stream.
      expect(late).toBeLessThan(32 * 1024 * 1024);
      expect(late).toBeGreaterThan(0); // sanity: the handshake worked and bytes flowed
    } finally {
      stream.destroy();
      sink.destroy();
      discard.destroy();
    }
  });

  it.each([1, 128, 129])(
    "resumes and completes once the destination drains (%i frames)",
    async (frameCount) => {
      // The other half: backpressure must be pressure, not a deadlock. Same wiring,
      // but the sink acknowledges writes, so the whole stream should get through.
      const expectedWireBytes = frameCount * CHUNK.length;
      daemon = await fakeDaemon(expectedWireBytes);
      const stream = await startAttachStream({ host: "127.0.0.1", port: daemon.port }, "helper_1", {
        stdin: false,
        stdout: true,
        stderr: true,
      });

      let received = 0;
      const draining = new Writable({
        highWaterMark: PAYLOAD.length,
        write(chunk: Buffer, _enc, cb) {
          received += chunk.byteLength;
          // Acknowledge on a later tick, so the path really does pause and resume
          // many times rather than never filling.
          setImmediate(cb);
        },
      });
      const discard = new Writable({ write: (_c, _e, cb) => cb() });
      const complete = Promise.all([
        finished(stream, { writable: false, cleanup: true }).then(() => {
          draining.end();
          discard.end();
        }),
        finished(draining, { cleanup: true }),
        finished(discard, { cleanup: true }),
      ]);
      demuxDockerStream(stream, draining, discard);

      try {
        await complete;
        expect(daemon.pushed()).toBe(expectedWireBytes);
        expect(received).toBe(frameCount * PAYLOAD.length);
      } finally {
        stream.destroy();
        draining.destroy();
        discard.destroy();
      }
    },
  );
});
