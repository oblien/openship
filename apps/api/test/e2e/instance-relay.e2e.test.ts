import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { INVITATION_DELIVERY_HEADER, INVITATION_DELIVERY_LINK_ONLY } from "@repo/core";
import { expect, it } from "vitest";
import { freePort, startApi, stopApi, jsonRequest } from "./fixtures/instance-api";

it("relays streams and terminal frames to one authenticated peer without leaking local authority or falling back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-instance-relay-"));
  const desktop = await startApi({
    dbDir: directory,
    port: await freePort(),
    secret: "instance-relay-test-00000000000000000000000",
  });
  const installationId = randomUUID();
  let origin = "",
    streamClosed = false,
    upgrades = 0;
  const peer = createServer(async (request, response) => {
    const reply = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/system/instance/pair/claim")
      return reply({
        origin,
        installationId,
        cookies: { "openship.session_token": "remote-device-session" },
      });
    if (request.url === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write("event: ready\ndata: first\n\n");
      const timer = setInterval(() => response.write(": keepalive\n\n"), 250);
      response.once("close", () => {
        streamClosed = true;
        clearInterval(timer);
      });
      return;
    }
    return reply({ headers: request.headers, path: request.url });
  });
  const sockets = new WebSocketServer({ noServer: true });
  peer.on("upgrade", (request, socket, head) => {
    upgrades++;
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.send(
        JSON.stringify({ cookie: request.headers.cookie, protocol: connection.protocol }),
      );
      connection.on("message", (data, binary) => connection.send(data, { binary }));
    });
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
  const post = (path: string, body: unknown = {}) =>
    jsonRequest(desktop.baseUrl, path, { method: "POST", body: JSON.stringify(body) });
  let terminal: WebSocket | undefined;
  try {
    const code = Buffer.from(
      JSON.stringify({
        protocol: 1,
        kind: "connection",
        origin,
        installationId,
        token: "A".repeat(43),
      }),
    ).toString("base64url");
    await post("/api/system/instance/connect", { code });

    // Desktop collection stays disabled through a remote-instance switch;
    // intake must not forward to whichever remote account is now active.
    const diagnostic = await fetch(`${desktop.baseUrl}/api/diagnostics/client-errors`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ name: "Error", message: "local UI observation" }] }),
    });
    expect(diagnostic.status).toBe(404);
    const echo = await jsonRequest<{ headers: Record<string, string> }>(
      desktop.baseUrl,
      "/api/echo",
      {
        headers: {
          "x-internal-token": "must-not-leave-desktop",
          authorization: "Bearer local-user-token",
          cookie: "local_secret=private",
          "x-organization-id": "selected-org",
          [INVITATION_DELIVERY_HEADER]: INVITATION_DELIVERY_LINK_ONLY,
        },
      },
    );
    expect(echo.headers.cookie).toBe("openship.session_token=remote-device-session");
    expect(echo.headers["x-organization-id"]).toBe("selected-org");
    expect(echo.headers[INVITATION_DELIVERY_HEADER]).toBe(INVITATION_DELIVERY_LINK_ONLY);
    expect(echo.headers["x-internal-token"]).toBeUndefined();
    expect(echo.headers.authorization).toBeUndefined();
    const stream = await fetch(`${desktop.baseUrl}/api/events`, {
      signal: AbortSignal.timeout(15_000),
    });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: first");

    terminal = new WebSocket(
      desktop.baseUrl.replace("http:", "ws:") + "/api/test-terminal",
      ["openship-ticket-test"],
      { origin: desktop.baseUrl },
    );
    const [greeting] = await once(terminal, "message");
    expect(JSON.parse(greeting.toString())).toEqual({
      cookie: "openship.session_token=remote-device-session",
      protocol: "openship-ticket-test",
    });
    const text = once(terminal, "message");
    terminal.send("terminal text");
    expect((await text)[0].toString()).toBe("terminal text");
    const binary = once(terminal, "message");
    terminal.send(Buffer.from([0, 255, 42]));
    expect(Buffer.from((await binary)[0])).toEqual(Buffer.from([0, 255, 42]));
    const rejected = new WebSocket(desktop.baseUrl.replace("http:", "ws:") + "/api/test-terminal", {
      origin: "https://untrusted.example",
    });
    await once(rejected, "error");
    expect(rejected.readyState).not.toBe(WebSocket.OPEN);
    expect(upgrades).toBe(1); // the untrusted browser never reached the peer

    await post("/api/system/instance/disconnect");
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          /* drain until closed */
        }
      })(),
    ).rejects.toThrow();
    for (let attempt = 0; attempt < 20 && !streamClosed; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(streamClosed).toBe(true);
    await post("/api/system/instance/connect", { code });
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    const unavailable = await fetch(`${desktop.baseUrl}/api/projects`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "REMOTE_INSTANCE_UNAVAILABLE" });
  } finally {
    terminal?.terminate();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    peer.closeAllConnections();
    peer.close();
    await stopApi(desktop);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
