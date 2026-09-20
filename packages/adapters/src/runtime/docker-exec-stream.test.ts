import { describe, expect, it, afterEach, vi } from "vitest";
import Dockerode from "dockerode";
import net from "node:net";
import { Readable } from "node:stream";
import {
  daemonConnectionFrom,
  installDockerodeBuildKitSessionWorkaround,
  startBuildKitSessionStream,
  startExecStream,
} from "./docker-exec-stream";

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
    const daemon = fakeDaemon(
      "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
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
      'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"no such exec"}',
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

describe("BuildKit session upgrade (#745)", () => {
  it("opens Docker's h2c session with the required identity headers", async () => {
    const daemon = fakeDaemon(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
    );
    servers.push(daemon.server);
    const port = await daemon.port;

    const duplex = await startBuildKitSessionStream(
      { host: "127.0.0.1", port },
      "session-745",
      "testcontainers",
    );
    duplex.destroy();

    const req = daemon.requests[0];
    expect(req).toContain("POST /session HTTP/1.1");
    expect(req).toContain("Connection: Upgrade");
    expect(req).toContain("Upgrade: h2c");
    expect(req).toContain("X-Docker-Expose-Session-Uuid: session-745");
    expect(req).toContain("X-Docker-Expose-Session-Name: testcontainers");
  });

  it("intercepts only dockerode's h2c session dial and delegates other requests", async () => {
    const daemon = fakeDaemon(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
    );
    servers.push(daemon.server);
    const port = await daemon.port;
    const originalDial = vi.fn();
    const docker = {
      modem: {
        host: "127.0.0.1",
        port,
        protocol: "http",
        dial: originalDial,
      },
    };
    installDockerodeBuildKitSessionWorkaround(docker);

    const stream = await new Promise<unknown>((resolve, reject) => {
      docker.modem.dial(
        {
          path: "/session",
          hijack: true,
          headers: {
            Upgrade: "h2c",
            "X-Docker-Expose-Session-Uuid": "session-745",
            "X-Docker-Expose-Session-Name": "testcontainers",
          },
        },
        (error: Error | null, result: unknown) => (error ? reject(error) : resolve(result)),
      );
    });
    expect(stream).toBeTruthy();
    (stream as { destroy?: () => void }).destroy?.();
    expect(originalDial).not.toHaveBeenCalled();

    docker.modem.dial({ path: "/build?", method: "POST" });
    expect(originalDial).toHaveBeenCalledOnce();
  });

  it("lets dockerode proceed from /session to the BuildKit request under Bun", async () => {
    const requests: string[] = [];
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.once("data", (chunk) => {
        const request = chunk.toString();
        requests.push(request);
        if (request.includes("POST /session ")) {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
          );
          return;
        }
        const body = '{"stream":"ok\\n"}\n';
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });

    const docker = new Dockerode({ host: "127.0.0.1", port, protocol: "http" });
    installDockerodeBuildKitSessionWorkaround(docker);
    try {
      const stream = await docker.buildImage(Readable.from([Buffer.from("tar")]), {
        version: "2",
        t: "issue-745-probe",
      });
      await new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.resume();
      });

      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("POST /session HTTP/1.1");
      expect(requests[1]).toMatch(/POST \/build\?.*version=2/);
      expect(requests[1]).toMatch(/POST \/build\?.*session=[0-9a-f-]+/);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it("rejects session identities that could inject an HTTP header", async () => {
    await expect(
      startBuildKitSessionStream(
        { host: "127.0.0.1", port: 1 },
        "valid\r\nInjected: yes",
        "openship",
      ),
    ).rejects.toThrow("Invalid Docker BuildKit session identity");
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
