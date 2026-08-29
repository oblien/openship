import { describe, expect, it, vi } from "vitest";
import { Duplex } from "node:stream";

class FakeTunnel extends Duplex {
  readonly written: Buffer[] = [];

  _read() {}

  _write(chunk: Buffer, _enc: BufferEncoding, done: () => void) {
    this.written.push(Buffer.from(chunk));
    done();
  }

  /** Everything the caller wrote onto the tunnel, byte for byte. */
  get sent(): string {
    return Buffer.concat(this.written).toString("latin1");
  }
}

const active = vi.hoisted(() => ({ tunnel: null as FakeTunnel | null }));

vi.mock("../../src/lib/ssh-manager", () => ({
  sshManager: {
    acquire: async () => ({ forwardPort: async () => active.tunnel }),
  },
}));

import { tunnelRequest, tunnelStream } from "../../src/lib/ssh-tunnel";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function openTunnel(): FakeTunnel {
  const tunnel = new FakeTunnel();
  active.tunnel = tunnel;
  return tunnel;
}

/** Resolves once the caller has written its request head onto the tunnel. */
async function awaitRequest(tunnel: FakeTunnel): Promise<string> {
  for (let i = 0; i < 100 && tunnel.written.length === 0; i++) await tick();
  await tick();
  return tunnel.sent;
}

/** Reply to the pending request with `raw`, then close the connection. */
async function reply(tunnel: FakeTunnel, raw: string, close = true) {
  await awaitRequest(tunnel);
  tunnel.push(Buffer.from(raw, "latin1"));
  if (close) tunnel.destroy();
}

const CHUNKED_BODY = '7\r\n{"a":1}\r\n0\r\n\r\n';

describe("tunnelRequest chunked framing", () => {
  it("decodes a lowercase chunked body", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${CHUNKED_BODY}`);

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("decodes a chunked body announced with different casing", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, `HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n${CHUNKED_BODY}`);

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("strips the chunk framing when chunked is listed after another coding", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(
      tunnel,
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n${CHUNKED_BODY}`,
    );

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("leaves a body with no transfer-encoding untouched", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{"a":1}');

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });
});

describe("tunnelRequest truncated responses", () => {
  it("fails a chunked body cut before the terminating chunk", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"a":1}\r\n');

    expect(await pending).toBeNull();
  });

  it("fails a response that delivers fewer bytes than Content-Length", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"a":1}');

    expect(await pending).toBeNull();
  });

  it("fails a connection that closes before the response head is complete", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, "HTTP/1.1 200 OK\r\nContent-Len");

    expect(await pending).toBeNull();
  });

  it("returns the body of a complete chunked response", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${CHUNKED_BODY}`);

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });

  it("returns the buffered body when the response has no length framing", async () => {
    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, "/health");
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"a":1}');

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
  });
});

const SSE_HEAD = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n";

describe("tunnelStream byte relay", () => {
  it("relays a multi-byte character split across the header boundary intact", async () => {
    const frame = Buffer.from('data: {"city":"München"}\n\n', "utf8");
    const cut = frame.indexOf(Buffer.from("ü", "utf8")) + 1;

    const tunnel = openTunnel();
    const pending = tunnelStream("srv_1", 9145, "/logs/stream");
    await awaitRequest(tunnel);
    tunnel.push(Buffer.concat([Buffer.from(SSE_HEAD), frame.subarray(0, cut)]));

    const handle = await pending;
    const relayed: Buffer[] = [];
    handle!.stream.on("data", (c: Buffer) => relayed.push(Buffer.from(c)));
    await tick();
    tunnel.push(frame.subarray(cut));
    await tick();
    handle!.destroy();

    expect(Buffer.concat(relayed).equals(frame)).toBe(true);
  });

  it("relays an ASCII leftover body after the headers unchanged", async () => {
    const frame = 'event: request\ndata: {"n":1}\n\n';

    const tunnel = openTunnel();
    const pending = tunnelStream("srv_1", 9145, "/logs/stream");
    await awaitRequest(tunnel);
    tunnel.push(Buffer.from(SSE_HEAD + frame));

    const handle = await pending;
    const relayed: Buffer[] = [];
    handle!.stream.on("data", (c: Buffer) => relayed.push(Buffer.from(c)));
    await tick();
    handle!.destroy();

    expect(Buffer.concat(relayed).toString()).toBe(frame);
  });

  it("parses the status line and headers of the stream response", async () => {
    const tunnel = openTunnel();
    const pending = tunnelStream("srv_1", 9145, "/logs/stream");
    await awaitRequest(tunnel);
    tunnel.push(Buffer.from(SSE_HEAD));

    const handle = await pending;

    expect(handle).toMatchObject({
      statusCode: 200,
      headers: { "content-type": "text/event-stream" },
    });
    handle!.destroy();
  });
});

describe("tunnel request head injection", () => {
  const CRLF_PATH = "/health\r\nX-Injected: yes\r\n\r\nGET /rules HTTP/1.1";

  it("refuses a tunnelRequest path containing CRLF", async () => {
    const tunnel = openTunnel();

    expect(await tunnelRequest("srv_1", 9145, CRLF_PATH)).toBeNull();
    expect(tunnel.sent).toBe("");
  });

  it("refuses a tunnelRequest header value containing CRLF", async () => {
    const tunnel = openTunnel();

    const result = await tunnelRequest("srv_1", 9145, "/health", {
      headers: { "X-Trace": "abc\r\nX-Injected: yes" },
    });

    expect(result).toBeNull();
    expect(tunnel.sent).toBe("");
  });

  it("refuses a tunnelRequest header name containing CRLF", async () => {
    const tunnel = openTunnel();

    const result = await tunnelRequest("srv_1", 9145, "/health", {
      headers: { "X-Trace\r\nX-Injected": "yes" },
    });

    expect(result).toBeNull();
    expect(tunnel.sent).toBe("");
  });

  it("refuses a tunnelRequest method containing CRLF", async () => {
    const tunnel = openTunnel();

    const result = await tunnelRequest("srv_1", 9145, "/health", {
      method: "GET /rules HTTP/1.1\r\nHost: 127.0.0.1:9145\r\n\r\nGET",
    });

    expect(result).toBeNull();
    expect(tunnel.sent).toBe("");
  });

  it("refuses a tunnelStream path containing CRLF", async () => {
    const tunnel = openTunnel();

    expect(await tunnelStream("srv_1", 9145, CRLF_PATH)).toBeNull();
    expect(tunnel.sent).toBe("");
  });

  it("refuses a tunnelStream header containing CRLF", async () => {
    const tunnel = openTunnel();

    const result = await tunnelStream("srv_1", 9145, "/logs/stream", {
      "X-Trace": "abc\r\nX-Injected: yes",
    });

    expect(result).toBeNull();
    expect(tunnel.sent).toBe("");
  });

  it("sends a percent-encoded path and a plain header through unchanged", async () => {
    const path = `/logs?domain=${encodeURIComponent("app.example.com\r\nX-Injected: yes")}`;

    const tunnel = openTunnel();
    const pending = tunnelRequest("srv_1", 9145, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    const sent = await awaitRequest(tunnel);
    await reply(tunnel, 'HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{"a":1}');

    expect(await pending).toMatchObject({ statusCode: 200, body: '{"a":1}' });
    expect(sent).toBe(
      `POST ${path} HTTP/1.1\r\n` +
        "Host: 127.0.0.1:9145\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 7\r\n" +
        "Content-Type: application/json\r\n" +
        '\r\n{"a":1}',
    );
  });

  it("sends a tunnelStream request head unchanged for a safe path", async () => {
    const tunnel = openTunnel();
    const pending = tunnelStream("srv_1", 9145, "/logs/stream?domain=app.example.com");
    const sent = await awaitRequest(tunnel);
    tunnel.destroy();
    await pending;

    expect(sent).toBe(
      "GET /logs/stream?domain=app.example.com HTTP/1.1\r\n" +
        "Host: 127.0.0.1:9145\r\n" +
        "Accept: text/event-stream\r\n" +
        "Connection: keep-alive\r\n\r\n",
    );
  });
});
