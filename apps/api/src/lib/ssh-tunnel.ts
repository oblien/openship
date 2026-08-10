/**
 * Reusable SSH TCP tunnel primitives.
 *
 * Wraps `executor.forwardPort()` (ssh2 `direct-tcpip` channel) to provide:
 *
 *   - `tunnelConnect`  - raw TCP duplex to a remote port
 *   - `tunnelRequest`  - one-shot HTTP request through tunnel
 *   - `tunnelStream`   - long-lived SSE / chunked stream through tunnel
 *   - `tunnelForward`  - VS Code-style local → remote port forwarding
 *
 * Every function takes a `serverId` and goes through `sshManager`, which
 * provides a pooled, idle-managed SSH connection per server.  No new TCP
 * connection is created per call - it multiplexes over the existing one.
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { sshManager } from "./ssh-manager";

// ─── Raw TCP tunnel ──────────────────────────────────────────────────────────

/**
 * Open a raw TCP tunnel (ssh2 `direct-tcpip`) to `remoteHost:remotePort`
 * on the given server.  Returns a full-duplex stream you can read/write
 * like a normal socket.
 *
 * Use this when you need a raw connection - e.g. forwarding a database
 * port to localhost, or any non-HTTP protocol.
 */
export async function tunnelConnect(
  serverId: string,
  remoteHost: string,
  remotePort: number,
): Promise<Duplex> {
  const executor = await sshManager.acquire(serverId);
  if (!executor.forwardPort) {
    throw new Error("Server executor does not support port tunnelling");
  }
  return executor.forwardPort(remoteHost, remotePort);
}

// ─── HTTP request through tunnel ─────────────────────────────────────────────

export interface TunnelRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface TunnelResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Whether any component of a request head contains a bare CR or LF.  The
 * request line and header lines below are assembled by hand, so a component
 * carrying one would terminate its own line and inject arbitrary extra
 * headers - or an entire second request - onto the tunnel.
 */
function hasCrlf(parts: string[]): boolean {
  return parts.some((part) => /[\r\n]/.test(part));
}

/**
 * Whether a `Transfer-Encoding` header value applies the chunked coding.
 * Transfer-coding names are case-insensitive and the header carries the
 * applied codings as a comma-separated list, chunked always last.
 */
function isChunkedEncoding(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  return value
    .toLowerCase()
    .split(",")
    .some((coding) => coding.trim() === "chunked");
}

/**
 * Parse a chunked-transfer-encoded body out of an accumulated buffer.
 * Returns the decoded body, or `null` if the buffer doesn't yet contain a
 * complete terminating chunk (0-length chunk + trailing CRLF).
 */
function decodeChunkedBody(buf: Buffer): Buffer | null {
  const out: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const sizeLine = buf.slice(offset, lineEnd).toString().split(";")[0].trim();
    const size = parseInt(sizeLine, 16);
    if (Number.isNaN(size)) return null;
    const chunkStart = lineEnd + 2;
    if (size === 0) return Buffer.concat(out);
    const chunkEnd = chunkStart + size;
    if (buf.length < chunkEnd + 2) return null; // chunk data + trailing CRLF not fully buffered yet
    out.push(buf.slice(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }
}

/**
 * Send a single HTTP request to `remoteHost:remotePort` through an SSH
 * tunnel.  Returns the full response (status, headers, body).
 *
 * Writes the request directly onto the tunnel's raw duplex and parses the
 * response by hand (same approach as `tunnelStream` below) rather than
 * going through `http.request({ createConnection })` — Bun's `node:http`
 * polyfill does not honor a caller-supplied `createConnection` socket (it
 * still attempts its own connection under the hood), which made every call
 * through this path fail with ECONNREFUSED and get silently swallowed to
 * `null`. Always sends `Connection: close` so the remote closes the socket
 * once the response is flushed — the simplest unambiguous end-of-body
 * signal alongside Content-Length/chunked framing.
 *
 * Returns `null` on connection error, timeout, a response truncated before
 * its declared framing completed, a method/path/header containing CR or LF,
 * or if the executor doesn't support tunnelling.
 */
export async function tunnelRequest(
  serverId: string,
  remotePort: number,
  path: string,
  opts: TunnelRequestOptions = {},
): Promise<TunnelResponse | null> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10_000,
  } = opts;

  if (hasCrlf([method, path, ...Object.entries(headers).flat()])) {
    return null;
  }

  let tunnel: Duplex;
  try {
    tunnel = await tunnelConnect(serverId, "127.0.0.1", remotePort);
  } catch {
    return null;
  }

  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : undefined;
  const headerLines = [
    `${method} ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${remotePort}`,
    "Connection: close",
    ...(bodyBuf ? [`Content-Length: ${bodyBuf.length}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ];

  return new Promise<TunnelResponse | null>((resolve) => {
    let settled = false;
    const finish = (result: TunnelResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tunnel.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    let buffer = Buffer.alloc(0);
    let headerEnd = -1;
    let statusCode = 0;
    let parsedHeaders: http.IncomingHttpHeaders = {};
    let contentLength: number | null = null;
    let isChunked = false;

    tunnel.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (headerEnd === -1) {
        headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const rawHead = buffer.slice(0, headerEnd).toString();
        const [statusLine, ...headerLinesRaw] = rawHead.split("\r\n");
        statusCode = parseInt(statusLine.split(" ")[1] ?? "0", 10);
        for (const line of headerLinesRaw) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            parsedHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
        }
        contentLength = parsedHeaders["content-length"]
          ? parseInt(parsedHeaders["content-length"] as string, 10)
          : null;
        isChunked = isChunkedEncoding(parsedHeaders["transfer-encoding"]);
      }

      const bodyBytes = buffer.slice(headerEnd + 4);

      if (isChunked) {
        const decoded = decodeChunkedBody(bodyBytes);
        if (decoded !== null) {
          finish({ statusCode, headers: parsedHeaders, body: decoded.toString() });
        }
      } else if (contentLength !== null) {
        if (bodyBytes.length >= contentLength) {
          finish({
            statusCode,
            headers: parsedHeaders,
            body: bodyBytes.slice(0, contentLength).toString(),
          });
        }
      }
      // Neither content-length nor chunked: wait for the remote to close
      // the connection (handled by the "close"/"end" listener below).
    });

    tunnel.on("error", () => finish(null));
    tunnel.on("close", () => {
      if (settled) return;
      // Only a response with no length framing at all is terminated by the
      // close itself ("Connection: close" with no Content-Length) — any other
      // framing would already have resolved above, so reaching here means the
      // remote hung up mid-response.
      if (headerEnd !== -1 && !isChunked && contentLength === null) {
        finish({
          statusCode,
          headers: parsedHeaders,
          body: buffer.slice(headerEnd + 4).toString(),
        });
      } else {
        finish(null);
      }
    });

    tunnel.write(Buffer.concat([Buffer.from(headerLines.join("\r\n")), bodyBuf ?? Buffer.alloc(0)]));
  });
}

// ─── Streaming (SSE / chunked) through tunnel ────────────────────────────────

export interface TunnelStreamHandle {
  /** The raw duplex stream - HTTP headers already consumed. */
  stream: Duplex;
  /** HTTP status code from the initial response. */
  statusCode: number;
  /** Parsed response headers. */
  headers: Record<string, string>;
  /** Tear down the tunnel. */
  destroy: () => void;
}

/**
 * Open a long-lived HTTP GET to `remoteHost:remotePort` through an SSH
 * tunnel.  Waits for the HTTP response headers, then returns the handle
 * with the underlying duplex stream positioned after the headers.
 *
 * Designed for SSE (`text/event-stream`) and chunked transfer:
 *
 * ```ts
 * const h = await tunnelStream(serverId, 9145, "/logs/stream?domain=x");
 * h.stream.on("data", chunk => console.log(chunk.toString()));
 * // later: h.destroy();
 * ```
 *
 * Sends `Accept: text/event-stream` and `Connection: keep-alive` by default.
 * Returns `null` on connection error, timeout, non-2xx status, or a
 * path/header containing CR or LF.
 */
export async function tunnelStream(
  serverId: string,
  remotePort: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<TunnelStreamHandle | null> {
  if (hasCrlf([path, ...Object.entries(extraHeaders).flat()])) {
    return null;
  }

  let tunnel: Duplex;
  try {
    tunnel = await tunnelConnect(serverId, "127.0.0.1", remotePort);
  } catch {
    return null;
  }

  // Build and send raw HTTP request
  const headerLines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${remotePort}`,
    "Accept: text/event-stream",
    "Connection: keep-alive",
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ];
  tunnel.write(headerLines.join("\r\n"));

  // Wait for response headers, then hand the stream back
  return new Promise<TunnelStreamHandle | null>((resolve) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      tunnel.destroy();
      resolve(null);
    }, 10_000);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      clearTimeout(timeout);
      tunnel.removeListener("data", onData);

      // Parse status line and headers
      const rawHead = buffer.slice(0, headerEnd).toString();
      const [statusLine, ...rawHeaderLines] = rawHead.split("\r\n");
      const statusCode = parseInt(statusLine.split(" ")[1] ?? "0", 10);

      const headers: Record<string, string> = {};
      for (const line of rawHeaderLines) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          headers[line.slice(0, colon).trim().toLowerCase()] =
            line.slice(colon + 1).trim();
        }
      }

      if (statusCode < 200 || statusCode >= 300) {
        tunnel.destroy();
        resolve(null);
        return;
      }

      // Re-emit leftover body bytes so the caller sees them
      const body = buffer.slice(headerEnd + 4);
      if (body.length > 0) {
        process.nextTick(() => tunnel.emit("data", body));
      }

      resolve({
        stream: tunnel,
        statusCode,
        headers,
        destroy: () => tunnel.destroy(),
      });
    };

    tunnel.on("data", onData);
    tunnel.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    tunnel.on("close", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ─── VS Code-style local port forwarding ─────────────────────────────────────

export interface ForwardHandle {
  /** The local port the server is listening on. */
  localPort: number;
  /** Remote host being forwarded. */
  remoteHost: string;
  /** Remote port being forwarded. */
  remotePort: number;
  /** Number of currently active connections. */
  get activeConnections(): number;
  /** Stop accepting new connections and tear down all active tunnels. */
  close: () => Promise<void>;
}

/**
 * Forward a remote port to localhost - VS Code SSH-style.
 *
 * Opens a TCP server on `localhost:preferredPort`.  If that port is busy,
 * it automatically picks the next available one (just like VS Code does
 * when a forwarded port is already taken).
 *
 * Every incoming local connection opens a `direct-tcpip` SSH channel to
 * `remoteHost:remotePort` and pipes bidirectionally.  All channels share
 * the single pooled SSH connection for the server.
 *
 * ```ts
 * const fwd = await tunnelForward(serverId, 5432);       // Postgres
 * console.log(`connect at localhost:${fwd.localPort}`);
 * // later:
 * await fwd.close();
 * ```
 */
export async function tunnelForward(
  serverId: string,
  remotePort: number,
  opts: {
    remoteHost?: string;
    preferredPort?: number;
    localHost?: string;
  } = {},
): Promise<ForwardHandle> {
  const {
    remoteHost = "127.0.0.1",
    preferredPort = remotePort,
    localHost = "127.0.0.1",
  } = opts;

  // Verify the executor supports tunnelling before binding a port
  const executor = await sshManager.acquire(serverId);
  if (!executor.forwardPort) {
    throw new Error("Server executor does not support port tunnelling");
  }

  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((local) => {
    activeSockets.add(local);
    local.on("close", () => activeSockets.delete(local));

    // Open an SSH tunnel channel for this connection
    tunnelConnect(serverId, remoteHost, remotePort)
      .then((remote) => {
        local.pipe(remote);
        remote.pipe(local);

        const cleanup = () => {
          local.destroy();
          remote.destroy();
        };
        local.on("error", cleanup);
        remote.on("error", cleanup);
        local.on("close", () => remote.destroy());
        remote.on("close", () => local.destroy());
      })
      .catch(() => {
        local.destroy();
      });
  });

  // Try preferred port, fall back to OS-assigned (port 0)
  const localPort = await new Promise<number>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && preferredPort !== 0) {
        // Port taken - let the OS pick one
        server.listen(0, localHost, () => {
          const addr = server.address() as net.AddressInfo;
          resolve(addr.port);
        });
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, localHost, () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
  });

  return {
    localPort,
    remoteHost,
    remotePort,
    get activeConnections() {
      return activeSockets.size;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of activeSockets) s.destroy();
        activeSockets.clear();
        server.close(() => resolve());
      }),
  };
}
