import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { SDK_CAPABILITIES, TERMINAL_SUBPROTOCOL_PREFIX } from "@repo/contracts";
import { OpenshipClient } from "../src/client";

interface RequestRecord {
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    initial?: object | null;
    ticket?: unknown;
    status?: number;
    connected?: (socket: WebSocket) => void;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const upgrades: RequestRecord[] = [];
  const messages: Array<{ bytes?: Buffer; control?: unknown }> = [];
  const sockets: WebSocket[] = [];
  const ready = {
    type: "ready",
    sessionId: "session-fixture",
    resumeToken: "resume-fixture",
    resumed: false,
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: req.url!, headers: req.headers, body: body ? JSON.parse(body) : null });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/control/api/health") {
      res.end(JSON.stringify({ sdk: SDK_CAPABILITIES }));
      return;
    }
    res.statusCode = options.status ?? 200;
    res.end(
      JSON.stringify(options.ticket ?? { success: true, token: "ticket-fixture", expiresIn: 30 }),
    );
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push({ path: req.url!, headers: req.headers, body: null });
    ws.handleUpgrade(req, socket, head, (connection) => {
      sockets.push(connection);
      connection.on("message", (data, binary) => {
        if (binary) messages.push({ bytes: Buffer.from(data as Buffer) });
        else messages.push({ control: JSON.parse(data.toString()) });
      });
      if (options.initial !== null) connection.send(JSON.stringify(options.initial ?? ready));
      options.connected?.(connection);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/control`,
    requests,
    upgrades,
    messages,
    sockets,
  };
}

describe("remote interactive terminals over real HTTP and WebSocket transports", () => {
  it.each(["server", "service"] as const)(
    "opens a %s terminal with a scoped one-use ticket and transparent binary I/O",
    async (kind) => {
      const f = await fixture({
        connected: (socket) => socket.send(new Uint8Array([0, 0x1b, 0xff])),
      });
      const bytes: Uint8Array[] = [];
      const ship = new OpenshipClient({
        baseUrl: f.baseUrl,
        token: "opsh_pat_fixture",
        organizationId: "org-fixture",
      });
      const session = await (
        kind === "server" ? ship.terminal.openServer : ship.terminal.openService
      )(`${kind}-fixture`, {
        origin: "https://dashboard.example.test",
        onData: (data) => bytes.push(data),
      });
      session.write("héllo\u0003");
      session.resize(120, 40);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(f.requests[1]).toMatchObject({
        path:
          kind === "server"
            ? "/control/api/terminal/ticket"
            : "/control/api/services/terminal/ticket",
        body: { [kind + "Id"]: `${kind}-fixture` },
        headers: {
          authorization: "Bearer opsh_pat_fixture",
          "x-organization-id": "org-fixture",
          "x-openship-scope": "fixed",
        },
      });
      expect(f.upgrades[0].path).toBe(
        kind === "server"
          ? "/control/api/terminal/ws/server-fixture"
          : "/control/api/services/terminal/ws/service-fixture",
      );
      expect(f.upgrades[0].headers.origin).toBe("https://dashboard.example.test");
      expect(f.upgrades[0].headers["sec-websocket-protocol"]).toBe(
        TERMINAL_SUBPROTOCOL_PREFIX + "ticket-fixture",
      );
      expect(f.upgrades[0].headers.authorization).toBeUndefined();
      expect(f.upgrades[0].path).not.toContain("ticket");
      expect(Buffer.concat(bytes)).toEqual(Buffer.from([0, 0x1b, 0xff]));
      expect(f.messages).toEqual([
        { bytes: Buffer.from("héllo\u0003") },
        { control: { type: "resize", cols: 120, rows: 40 } },
      ]);
      expect(() => session.resize(0, 24)).toThrow("dimensions");
      f.sockets[0].send(JSON.stringify({ type: "exit", code: 7 }));
      expect(await session.closed).toEqual({ type: "exit", code: 7 });
      expect(() => session.write("after exit")).toThrow("not connected");
    },
  );

  it("explicitly closes a remote shell instead of parking it", async () => {
    const f = await fixture();
    const session = await new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer(
      "server-fixture",
      {
        origin: "https://dashboard.example.test",
        onData: () => {},
      },
    );
    const closed = once(f.sockets[0], "close");
    session.close();
    expect(await session.closed).toMatchObject({ signal: "client_close" });
    await closed;
    expect(f.messages).toContainEqual({ control: { type: "close" } });
  });

  it("does not retry or open another shell after a denied resume", async () => {
    const f = await fixture({
      initial: {
        type: "error",
        code: "resume_failed",
        message: "The saved session is no longer available",
      },
    });
    await expect(
      new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer("server-fixture", {
        origin: "https://dashboard.example.test",
        onData: () => {},
        resumeToken: "resume-fixture",
      }),
    ).rejects.toMatchObject({ message: "The saved session is no longer available" });
    expect(f.requests).toHaveLength(1);
    expect(f.upgrades).toHaveLength(1);
    expect(f.upgrades[0].headers["sec-websocket-protocol"]).toContain(
      "openship.terminal.resume+resume-fixture",
    );
  });

  it("does not open a WebSocket after an authorization denial", async () => {
    const f = await fixture({ status: 403, ticket: { error: "Server administration required" } });
    await expect(
      new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer("server-fixture", {
        origin: "https://dashboard.example.test",
        onData: () => {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.requests).toHaveLength(1);
    expect(f.upgrades).toEqual([]);
  });

  it("rejects malformed ticket responses without exposing them in an error", async () => {
    const secret = "bad ticket SECRET";
    const f = await fixture({ ticket: { success: true, token: secret, expiresIn: 30 } });
    await expect(
      new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer("server-fixture", {
        origin: "https://dashboard.example.test",
        onData: () => {},
      }),
    ).rejects.toMatchObject({ message: "Invalid terminal ticket response", body: null });
    expect(f.upgrades).toEqual([]);
  });

  it("bounds the readiness handshake and closes the pending connection", async () => {
    const f = await fixture({ initial: null });
    await expect(
      new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer("server-fixture", {
        origin: "https://dashboard.example.test",
        onData: () => {},
        connectTimeoutMs: 100,
      }),
    ).rejects.toThrow("timed out");
    expect(f.upgrades).toHaveLength(1);
  });

  it("treats a dropped connection as unknown completion, never a successful exit", async () => {
    const f = await fixture();
    const session = await new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer(
      "server-fixture",
      {
        origin: "https://dashboard.example.test",
        onData: () => {},
      },
    );
    f.sockets[0].terminate();
    await expect(session.closed).rejects.toThrow("before a shell exit was confirmed");
  });

  it("aborts a live terminal and requests remote shell teardown", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const session = await new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openService(
      "service-fixture",
      {
        origin: "https://dashboard.example.test",
        onData: () => {},
        signal: abort.signal,
      },
    );
    const closed = once(f.sockets[0], "close");
    abort.abort(new Error("User cancelled"));
    await expect(session.closed).rejects.toThrow("User cancelled");
    await closed;
    expect(f.messages).toContainEqual({ control: { type: "close" } });
  });

  it("does not mint a ticket for a pre-aborted operation", async () => {
    const f = await fixture();
    await expect(
      new OpenshipClient({ baseUrl: f.baseUrl }).terminal.openServer("server-fixture", {
        onData: () => {},
        signal: AbortSignal.abort(new Error("Cancelled")),
      }),
    ).rejects.toThrow("Cancelled");
    expect(f.requests).toEqual([]);
  });
});
