import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as httpServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type { Runtime } from "oblien";
import type { ManagedCommandRef } from "@repo/core";
import { createCloudDockerTransport, dockerWebSocketStream } from "./docker-transport";
import { CLOUD_DOCKER_BRIDGE_PORT, CLOUD_DOCKER_BRIDGE_SOURCE, CLOUD_DOCKER_BRIDGE_VERSION } from "./docker-bridge-source";
import { withManagedCommandTracking } from "./command-tracking";
import { openCloudDockerStream, recoverCloudDockerRequest } from "./docker-request";

/** Real Python bridge + WebSocket + private Unix socket. The upstream is a fake
 * Docker HTTP server, so no customer/host Docker daemon is needed. */
describe("Oblien Docker byte transport", () => {
  let directory: string;
  let python: ChildProcess;
  let transport: ReturnType<typeof createCloudDockerTransport>;
  let socketPath: string;
  let bridgeUrl: string;
  let receiveHalfClosedRequest: ((body: Buffer) => void) | undefined;
  let mutationStarted: (() => void) | undefined;
  let finishMutation: (() => void) | undefined;
  const sockets = new Set<Socket>();
  const upstream = httpServer((req, res) => {
    if (req.url === "/_ping") return void res.end("OK");
    if (req.url === "/broken") return void req.socket.destroy();
    if (req.url === "/slow-mutation") {
      req.resume();
      finishMutation = () => res.end("done");
      mutationStarted?.();
      return;
    }
    // Full-duplex echo exercises streamed archives, binary bytes, and bodies
    // larger than both a WebSocket frame and the stream high water mark.
    res.writeHead(200, { "content-type": "application/octet-stream" });
    req.pipe(res);
  });
  upstream.on("connection", socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
  });
  upstream.on("upgrade", (req, socket, head) => {
    socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    if (req.url === "/half-close") {
      const chunks = head.length ? [head] : [];
      socket.on("data", data => chunks.push(data));
      socket.on("end", () => receiveHalfClosedRequest?.(Buffer.concat(chunks)));
      socket.end("response complete");
      return;
    }
    if (head.length) socket.write(head);
    socket.on("data", data => socket.write(data));
    socket.on("end", () => socket.end());
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "openship-bridge-test-"));
    // macOS limits Unix socket paths to ~104 bytes; tmpdir can itself be long.
    const upstreamPath = join(directory, "up.sock");
    upstream.listen(upstreamPath);
    await once(upstream, "listening");
    const reserve = httpServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    const script = join(directory, "bridge.py");
    await writeFile(script, CLOUD_DOCKER_BRIDGE_SOURCE
      .replace('"/var/run/docker.sock"', JSON.stringify(upstreamPath))
      .replace('"/opt/openship/cloud-docker/requests"', JSON.stringify(join(directory, "requests")))
      .replace("EPOCH = host_epoch()", 'EPOCH = "test-boot"')
      .replace('("127.0.0.1", 23750)', `("127.0.0.1", ${port})`));
    python = spawn("python3", [script], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    python.stderr!.on("data", data => { errors += String(data); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = await (await fetch(`http://127.0.0.1:${port}/health`)).text() === CLOUD_DOCKER_BRIDGE_VERSION;
        if (ready) break;
      } catch { /* Process is still starting. */ }
      if (python.exitCode !== null) throw new Error(`Bridge exited: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(ready, errors).toBe(true);
    bridgeUrl = `ws://127.0.0.1:${port}/docker`;
    transport = createCloudDockerTransport(() => dockerWebSocketStream(new WebSocket(bridgeUrl)));
    socketPath = (await transport.establish()).socketPath!;
  });
  afterAll(async () => {
    await transport?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    python?.kill("SIGTERM");
    if (python && python.exitCode === null) await once(python, "exit");
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function roundtrip(path: string, payload?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, path, method: payload ? "POST" : "GET", agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  function guest(): Runtime {
    const base = bridgeUrl.slice(0, -"/docker".length);
    return { proxy: () => ({
      ws: (path: string) => new WebSocket(base + path),
      fetch: (path: string, init: RequestInit) => fetch(base.replace("ws:", "http:") + path, init),
    }) } as unknown as Runtime;
  }
  const identity = (id = randomUUID()): ManagedCommandRef => ({
    workspaceId: "test-vm", marker: "openship-exec-" + id + ":", kind: "docker",
  });

  it("waits for the guest's persisted acknowledgement before releasing a tracked request", async () => {
    const pending = new Map<string, ManagedCommandRef>();
    let completed = 0;
    await withManagedCommandTracking({
      record: async ref => { pending.set(ref.marker, ref); },
      complete: async marker => { await new Promise(resolve => setTimeout(resolve, 20)); pending.delete(marker); completed++; },
    }, async () => {
      const stream = await openCloudDockerStream(guest(), "test-vm");
      const ended = once(stream, "end");
      stream.resume();
      stream.end("POST /archive HTTP/1.1\r\nHost: docker\r\nContent-Length: 3\r\n\r\none");
      await ended;
      stream.destroy();
    });
    expect(completed).toBe(1);
    expect(pending.size).toBe(0);
  });

  it("keeps a mutation reserved after a lost controller until Docker finishes it", async () => {
    const pending = new Map<string, ManagedCommandRef>();
    const started = new Promise<void>(resolve => { mutationStarted = resolve; });
    let released = false;
    const run = withManagedCommandTracking({
      record: async ref => { pending.set(ref.marker, ref); },
      complete: async marker => { pending.delete(marker); },
    }, async () => {
      const stream = await openCloudDockerStream(guest(), "test-vm");
      stream.resume();
      stream.write("POST /slow-mutation HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n");
      await started;
      stream.destroy();
    }).then(() => { released = true; });
    void run.catch(() => {});
    try {
      await started;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(pending.size).toBe(1);
      expect(released).toBe(false);
      finishMutation!();
      await run;
      expect(pending.size).toBe(0);
    } finally {
      finishMutation?.();
      await run;
      mutationStarted = undefined;
      finishMutation = undefined;
    }
  });

  it("tombstones an unacknowledged handshake so a delayed request cannot start", async () => {
    const id = randomUUID();
    await recoverCloudDockerRequest(guest(), identity(id));
    const socket = guest().proxy(CLOUD_DOCKER_BRIDGE_PORT).ws("/docker/" + id);
    await expect(dockerWebSocketStream(socket)).rejects.toThrow("connection failed");
  });

  it("retains an uncertain mutation across a bridge crash but recognizes a new server lifetime", async () => {
    await mkdir(join(directory, "requests"), { recursive: true });
    const interrupted = randomUUID();
    await writeFile(join(directory, "requests", interrupted + ".pending"), "test-boot");
    await expect(recoverCloudDockerRequest(guest(), identity(interrupted))).rejects.toMatchObject({
      code: "CLOUD_COMMAND_EXIT_UNCONFIRMED",
    });
    const restarted = randomUUID();
    await writeFile(join(directory, "requests", restarted + ".pending"), "older-boot");
    await expect(recoverCloudDockerRequest(guest(), identity(restarted))).resolves.toBeUndefined();
  });
  it("keeps concurrent Docker requests isolated", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => roundtrip("/_ping")));
    expect(results.map(result => result.toString())).toEqual(Array(12).fill("OK"));
  });
  it("streams repeated binary archives without corruption", async () => {
    const payload = randomBytes(3 * 1024 * 1024 + 37);
    // Exercise independent close handshakes: an early bridge shutdown can
    // discard the last TCP segment on Linux while passing a single transfer.
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await roundtrip("/archive", payload)).equals(payload)).toBe(true);
    }
  });
  it("keeps the request writable after Docker finishes its response", async () => {
    const requestBody = new Promise<Buffer>(resolve => { receiveHalfClosedRequest = resolve; });
    const stream = await dockerWebSocketStream(new WebSocket(bridgeUrl));
    const response: Buffer[] = [];
    stream.on("data", chunk => response.push(chunk));
    try {
      const ended = once(stream, "end");
      stream.write("POST /half-close HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n");
      await ended;
      expect(Buffer.concat(response).toString()).toContain("response complete");
      const payload = randomBytes(3 * 1024 * 1024 + 17);
      const finished = once(stream, "finish");
      stream.end(payload);
      await finished;
      expect((await requestBody).equals(payload)).toBe(true);
    } finally {
      stream.destroy();
      receiveHalfClosedRequest = undefined;
    }
  });
  it("preserves the request and backpressure in Bun while the provider connection opens", async () => {
    // The production API runs in Bun. Node alone missed Bun's paused Unix
    // socket data loss during an asynchronous WebSocket authentication step.
    const script = `
      import { createCloudDockerTransport, dockerWebSocketStream } from ${JSON.stringify(new URL("./docker-transport.ts", import.meta.url).pathname)};
      import { request } from "node:http";
      import { randomBytes } from "node:crypto";
      const t = createCloudDockerTransport(async () => {
        await new Promise(r => setTimeout(r, 100));
        return dockerWebSocketStream(new WebSocket(${JSON.stringify(bridgeUrl)}));
      });
      const { socketPath } = await t.establish();
      const data = randomBytes(3 * 1024 * 1024 + 17);
      try {
        const output = await new Promise((resolve, reject) => {
          const req = request({ socketPath, path: "/archive", method: "POST", agent: false }, res => {
            const bytes = []; res.on("data", b => bytes.push(b)); res.on("error", reject);
            res.on("end", () => resolve(Buffer.concat(bytes)));
          });
          req.on("error", reject); req.end(data);
        });
        if (!output.equals(data)) throw new Error("Binary request corrupted");
        process.stdout.write("ok");
      } finally { await t.close(); }
    `;
    const { stdout } = await promisify(execFile)("bun", ["--eval", script], { timeout: 20_000 });
    expect(stdout).toBe("ok");
  });
  it("supports the raw HTTP upgrade used by container exec and terminals", async () => {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    socket.on("error", () => {});
    const received: Buffer[] = [];
    let size = 0;
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const payload = randomBytes(70_017);
    let upgraded = false;
    socket.on("data", data => {
      if (!upgraded) {
        expect(data.toString()).toContain("101 UPGRADED");
        upgraded = true;
        socket.write(payload);
        return;
      }
      received.push(data); size += data.length;
      if (size === payload.length) complete();
    });
    socket.write("POST /exec/1/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n");
    try {
      await done;
      expect(Buffer.concat(received)).toEqual(payload);
      socket.end();
      await once(socket, "end");
    } finally { socket.destroy(); }
  });
  it("reports a broken upstream instead of falling back to another Docker host", async () => {
    await expect(roundtrip("/broken")).rejects.toThrow();
    expect(await roundtrip("/_ping")).toEqual(Buffer.from("OK"));
  });
});
