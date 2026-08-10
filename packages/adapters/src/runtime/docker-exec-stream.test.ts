import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import { daemonConnectionFrom, startExecStream } from "./docker-exec-stream";

/**
 * Fake daemon: records the raw request bytes and replies with whatever the test
 * wants. Pins the WIRE CONTRACT of the upgrade we hand-roll (dockerode's hijack
 * hangs under Bun — see docker-exec-stream.ts), which is the whole point of
 * owning this by hand.
 */
function fakeDaemon(reply: string | ((req: string) => string)) {
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const req = chunk.toString();
      requests.push(req);
      socket.write(typeof reply === "function" ? reply(req) : reply);
    });
  });
  const listening = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  return { server, requests, port: listening };
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("startExecStream", () => {
  it("sends a well-formed upgrade request and resolves the raw socket on 101", async () => {
    const daemon = fakeDaemon("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    servers.push(daemon.server);
    const port = await daemon.port;

    const duplex = await startExecStream({ host: "127.0.0.1", port }, "exec_abc", {
      tty: true,
      stdin: true,
    });
    expect(duplex).toBeTruthy();
    duplex.destroy();

    const req = daemon.requests[0];
    expect(req).toContain("POST /exec/exec_abc/start HTTP/1.1");
    // Without these two the daemon streams a normal response body instead of
    // handing over the connection, and stdin would never reach the shell.
    expect(req).toContain("Connection: Upgrade");
    expect(req).toContain("Upgrade: tcp");
    expect(req).toContain('{"Detach":false,"Tty":true}');
  });

  it("preserves output that arrives in the same packet as the header", async () => {
    // The shell's first prompt often rides along with the 101 head; dropping it
    // leaves the terminal looking dead until the user presses a key.
    const daemon = fakeDaemon(
      "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n/ # ",
    );
    servers.push(daemon.server);
    const port = await daemon.port;

    const duplex = await startExecStream({ host: "127.0.0.1", port }, "exec_abc", {
      tty: true,
      stdin: true,
    });
    const first = await new Promise<string>((resolve) => {
      duplex.once("data", (c: Buffer) => resolve(c.toString()));
      duplex.resume(); // the stream is handed back paused — see startExecStream
    });
    expect(first).toBe("/ # ");
    duplex.destroy();
  });

  it("rejects with the status line and body when the daemon refuses", async () => {
    const daemon = fakeDaemon(
      "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{\"message\":\"no such exec\"}",
    );
    servers.push(daemon.server);
    const port = await daemon.port;

    await expect(
      startExecStream({ host: "127.0.0.1", port }, "exec_gone", { tty: true, stdin: true }),
    ).rejects.toThrow(/404 Not Found.*no such exec/s);
  });

  it("rejects when the connection closes before any upgrade", async () => {
    const server = net.createServer((socket) => socket.destroy());
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });

    await expect(
      startExecStream({ host: "127.0.0.1", port }, "exec_abc", { tty: true, stdin: true }),
    ).rejects.toThrow(/closed before upgrade|ECONNRESET/);
  });
});

describe("daemonConnectionFrom", () => {
  it("carries a unix socket path through", () => {
    expect(daemonConnectionFrom({ modem: { socketPath: "/var/run/docker.sock" } })).toMatchObject({
      socketPath: "/var/run/docker.sock",
    });
  });

  it("carries host/port — the shape the SSH bridge exposes", () => {
    expect(
      daemonConnectionFrom({ modem: { host: "127.0.0.1", port: 43210, protocol: "http" } }),
    ).toMatchObject({ host: "127.0.0.1", port: 43210, protocol: "http" });
  });

  it("tolerates a missing modem rather than throwing", () => {
    expect(daemonConnectionFrom({})).toEqual({
      socketPath: undefined,
      host: undefined,
      port: undefined,
      protocol: undefined,
      ca: undefined,
      cert: undefined,
      key: undefined,
    });
  });
});
