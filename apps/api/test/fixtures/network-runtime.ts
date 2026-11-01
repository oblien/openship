import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { safeFetch } from "@repo/platform/engine/lib/safe-fetch";

const mode = process.argv[2];
const registryPort = Number(process.argv[3]);
const registryUrl = `https://localhost:${registryPort}/v2/`;

if (mode === "tls") {
  const response = await safeFetch(registryUrl, { allowPrivate: true });
  assert.equal(response.status, 401);
  assert.equal(response.headers["www-authenticate"], 'Basic realm="runtime-test"');
  assert.deepEqual(await response.json(), { host: `localhost:${registryPort}`, sni: "localhost" });
  // The test certificate has only DNS:localhost, never an IP SAN. Success above
  // must not come from turning off identity checks or trusting any certificate.
  await assert.rejects(safeFetch(`https://127.0.0.1:${registryPort}/v2/`, { allowPrivate: true }), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
} else if (mode === "untrusted-ca") {
  await assert.rejects(safeFetch(registryUrl, { allowPrivate: true }), (error) => {
    assert.match(String((error as NodeJS.ErrnoException).code), /CERT|ISSUER|VERIFY/);
    return true;
  });
} else if (mode === "websocket") {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const { setupWebSocket, upgradeWebSocket, injectWebSocket } = await import("../../src/lib/ws");
  const { issueTerminalTicket, consumeTerminalTicket } =
    await import("../../src/lib/terminal-session-manager");
  const app = new Hono();
  setupWebSocket(app);
  const prefix = "openship.terminal.v1+";
  const { token } = issueTerminalTicket(
    {
      userId: "runtime-user",
      organizationId: "runtime-org",
    } as Parameters<typeof issueTerminalTicket>[0],
    "runtime-server",
  );

  // Use the shipped Hono adapter and ticket store. The network regression is an
  // event-loop turn BEFORE handleUpgrade; controller tests cover SSH and DB work.
  app.get(
    "/api/terminal/ws/:serverId",
    upgradeWebSocket(async (c) => {
      await delay(5);
      const protocol = c.req.header("sec-websocket-protocol") ?? "";
      const ticket = consumeTerminalTicket(
        protocol.startsWith(prefix) ? protocol.slice(prefix.length) : "",
      );
      const authorized = ticket?.serverId === c.req.param("serverId");
      return {
        onOpen(_event, ws) {
          if (authorized) ws.send(JSON.stringify({ type: "ready" }));
          else {
            ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
            ws.close(4401);
          }
        },
        onMessage(event, ws) {
          if (authorized) ws.send(JSON.stringify({ type: "data", data: String(event.data) }));
        },
      };
    }),
  );
  app.get("/health", (c) => c.text("ok"));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const clients: WebSocket[] = [];
  async function connect(protocol?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws/runtime-server`, protocol);
    clients.push(ws);
    const frames: unknown[] = [];
    return new Promise<{ code: number; frames: unknown[] }>((resolve, reject) => {
      ws.addEventListener("error", () => reject(new Error("WebSocket handshake failed")));
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (frame.type === "ready") ws.send("terminal input");
        if (frame.type === "data") ws.close(1000);
      });
      ws.addEventListener("close", (event) => resolve({ code: event.code, frames }));
    });
  }
  try {
    assert.deepEqual(await connect(`${prefix}${token}`), {
      code: 1000,
      frames: [{ type: "ready" }, { type: "data", data: "terminal input" }],
    });
    for (const protocol of [undefined, `${prefix}${token}`]) {
      assert.deepEqual(await connect(protocol), {
        code: 4401,
        frames: [{ type: "error", message: "Unauthorized" }],
      });
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    }
  } finally {
    for (const client of clients) client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
} else {
  throw new Error(`Unknown runtime probe: ${mode}`);
}

console.log(
  `network-runtime: ${mode} passed (${process.versions.bun ? `Bun ${process.versions.bun}` : process.version})`,
);
