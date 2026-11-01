import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { Readable } from "node:stream";
import { startAttachStream } from "./docker-exec-stream";

/**
 * Runs under Bun too (`test:bun`): the product ships on Bun, and the #1417
 * truncation only reproduced there. On Bun 1.3.14 `socket.end()` closed the
 * whole connection instead of half-closing it, so the daemon cancelled the
 * restore helper's stdin copy; Bun 1.4.4 half-closes like Node.
 */
const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("startAttachStream stdin EOF (#1417)", () => {
  /**
   * Fake attach endpoint shaped like the restore helper: it consumes stdin until
   * EOF and only then answers with the byte count, the way `tar -x` exits and
   * reports after its input ends. A transport whose `end()` closes the whole
   * connection instead of half-closing it (Bun 1.3.x) never sees that answer,
   * and a real daemon cancels its stdin copy at a 32 KiB boundary.
   */
  function countingDaemon() {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let head = true;
      let received = 0;
      socket.on("data", (chunk: Buffer) => {
        if (!head) {
          received += chunk.length;
          return;
        }
        const text = chunk.toString("latin1");
        const end = text.indexOf("\r\n\r\n");
        if (end === -1) return;
        head = false;
        received += chunk.length - (end + 4);
        socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      });
      socket.on("end", () => setTimeout(() => socket.end(`received=${received}`), 20));
    });
    servers.push(server);
    return new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  it.each([468_867, 32 * 1024 * 1024])(
    "delivers every byte of a %i byte upload and the reply sent after EOF",
    async (size) => {
      const port = await countingDaemon();
      const stream = await startAttachStream({ host: "127.0.0.1", port }, "restore", {
        stdin: true,
        stdout: true,
        stderr: true,
      });
      const reply = new Promise<string>((resolve, reject) => {
        let text = "";
        stream.on("data", (chunk: Buffer) => (text += chunk.toString()));
        stream.on("error", reject);
        stream.on("close", () => resolve(text));
        stream.resume();
      });
      const chunk = Buffer.alloc(64 * 1024, 7);
      Readable.from(
        (function* () {
          for (let sent = 0; sent < size; sent += chunk.length)
            yield chunk.subarray(0, Math.min(chunk.length, size - sent));
        })(),
      ).pipe(stream);

      expect(await reply).toBe(`received=${size}`);
    },
    30_000,
  );
});
