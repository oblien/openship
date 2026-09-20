import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import type { DockerTransport } from "../docker-transport";

/** Binary, bounded, half-close-aware stream over the provider's authenticated proxy. */
export async function dockerWebSocketStream(socket: WebSocket): Promise<Duplex> {
  socket.binaryType = "arraybuffer";
  let ended = false;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let resumeWrite: (() => void) | undefined;
  const writeWindow = 262144;
  let writeCredit = writeWindow;
  let unacknowledged = 0;
  const acknowledge = () => {
    if (unacknowledged && socket.readyState === 1) {
      socket.send(`ack:${unacknowledged}`);
      unacknowledged = 0;
    }
  };
  const stream = new Duplex({
    read() { acknowledge(); },
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const send = () => {
        if (pendingWrite) clearTimeout(pendingWrite);
        if (socket.readyState !== 1) return callback(new Error("Cloud Docker connection closed"));
        try {
          while (offset < chunk.length) {
            if (writeCredit <= 0) return;
            if (socket.bufferedAmount > 1024 * 1024) {
              pendingWrite = setTimeout(send, 10);
              return;
            }
            const size = Math.min(65536, writeCredit, chunk.length - offset);
            socket.send(new Uint8Array(chunk.subarray(offset, offset + size)));
            writeCredit -= size;
            offset += size;
          }
          resumeWrite = undefined;
          callback();
        } catch {
          callback(new Error("Cloud Docker write failed"));
        }
      };
      resumeWrite = send;
      send();
    },
    final(callback) {
      // A completed WebSocket send can still be queued inside the bridge.
      // Wait for Docker's write acknowledgements before EOF lets this Duplex
      // auto-destroy and close the connection after a response half-close.
      const finish = () => {
        if (socket.readyState !== 1) {
          resumeWrite = undefined;
          callback(new Error("Cloud Docker connection closed"));
          return;
        }
        if (writeCredit !== writeWindow) return;
        resumeWrite = undefined;
        try {
          socket.send("eof");
        } catch {
          callback(new Error("Cloud Docker write failed"));
          return;
        }
        callback();
      };
      resumeWrite = finish;
      finish();
    },
    destroy(error, callback) {
      if (pendingWrite) clearTimeout(pendingWrite);
      resumeWrite = undefined;
      socket.close();
      callback(error);
    },
  });
  // Connection failures are reported without the WebSocket URL (which carries auth).
  stream.on("error", () => {});
  socket.addEventListener("message", ({ data }) => {
    if (data === "eof") {
      ended = true;
      stream.push(null);
    } else if (typeof data === "string" && data.startsWith("ack:")) {
      const amount = Number(data.slice(4));
      if (!Number.isInteger(amount) || amount <= 0 || writeCredit + amount > writeWindow) {
        stream.destroy(new Error("Invalid cloud Docker flow-control frame"));
        return;
      }
      writeCredit += amount;
      resumeWrite?.();
    } else if (data instanceof ArrayBuffer) {
      if (stream.readableLength + data.byteLength > 32 * 1024 * 1024) {
        stream.destroy(new Error("Cloud Docker consumer stopped reading"));
      } else {
        unacknowledged += data.byteLength;
        if (stream.push(Buffer.from(data))) acknowledge();
      }
    } else {
      stream.destroy(new Error("Invalid cloud Docker frame"));
    }
  });
  socket.addEventListener("close", () => {
    if (!ended && !stream.destroyed) stream.destroy(new Error("Cloud Docker connection interrupted"));
  });
  socket.addEventListener("error", () => stream.destroy(new Error("Cloud Docker connection failed")));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new Error("Cloud Docker connection timed out"));
    }, 20_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      if (error) reject(error); else resolve();
    };
    const opened = () => finish();
    const failed = () => finish(new Error("Cloud Docker connection failed"));
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
    if (socket.readyState === 1) opened();
  });
  return stream;
}

/** A private local socket forwards raw Docker connections, including HTTP upgrades.
 * There is no fallback to the control-plane host's Docker daemon. */
export function createCloudDockerTransport(open: () => Promise<Duplex>): DockerTransport {
  let server: Server | undefined;
  let directory: string | undefined;
  let closed = false;
  const sockets = new Set<Duplex>();
  return {
    kind: "cloud",
    description: "Docker inside an Oblien workspace",
    unreachableHint: "Check that the project's Oblien Docker workspace is running and reachable.",
    async establish() {
      if (closed) throw new Error("Cloud Docker transport is closed");
      directory = await mkdtemp(join(tmpdir(), "openship-cloud-docker-"));
      const socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\openship-cloud-docker-${randomUUID()}`
        : join(directory, "docker.sock");
      server = createServer({ allowHalfOpen: true }, (client: Socket) => {
        sockets.add(client);
        client.on("error", () => {});
        client.once("close", () => sockets.delete(client));
        // Attach a bounded consumer immediately. Bun 1.3 loses bytes sent to a
        // Unix socket paused before an asynchronous upstream finishes opening.
        // A PassThrough preserves that first request and applies backpressure
        // while the provider authenticates the connection.
        const pending = new PassThrough({ highWaterMark: 64 * 1024 });
        sockets.add(pending);
        pending.on("error", () => client.destroy());
        pending.once("close", () => sockets.delete(pending));
        client.once("close", () => pending.destroy());
        client.pipe(pending);
        void open().then((upstream) => {
          if (closed || client.destroyed) { upstream.destroy(); return; }
          sockets.add(upstream);
          upstream.on("error", () => client.destroy());
          upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
          client.once("close", () => upstream.destroy());
          pending.pipe(upstream).pipe(client);
        }, (error: unknown) => {
          // No upstream byte has been forwarded yet, so report the actual
          // connection failure through Docker's normal JSON error contract.
          // A bare reset hides provisioning and bridge errors from operators.
          if (closed || client.destroyed || client.writableEnded) return client.destroy();
          const message = (error instanceof Error ? error.message : "Cloud Docker connection failed")
            .replace(/([?&](?:token|access_token)=)[^&\s]+/gi, "$1[redacted]");
          const body = JSON.stringify({ message });
          client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
      });
      // Per-connection failures are handled above; a late listener error must
      // not crash the API process while another deployment is running.
      server.on("error", () => { for (const socket of sockets) socket.destroy(); });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(socketPath, () => { server!.removeListener("error", reject); resolve(); });
      });
      return { socketPath, timeout: 600_000 };
    },
    async preflight() {},
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
