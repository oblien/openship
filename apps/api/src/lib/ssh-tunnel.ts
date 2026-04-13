/**
 * Reusable SSH TCP tunnel primitives.
 *
 * Wraps `executor.forwardPort()` (ssh2 `direct-tcpip` channel) to provide:
 *
 *   - `tunnelConnect`  — raw TCP duplex to a remote port
 *   - `tunnelRequest`  — one-shot HTTP request through tunnel
 *   - `tunnelStream`   — long-lived SSE / chunked stream through tunnel
 *   - `tunnelForward`  — VS Code-style local → remote port forwarding
 *
 * Every function takes a `serverId` and goes through `sshManager`, which
 * provides a pooled, idle-managed SSH connection per server.  No new TCP
 * connection is created per call — it multiplexes over the existing one.
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
 * Use this when you need a raw connection — e.g. forwarding a database
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
 * Send a single HTTP request to `remoteHost:remotePort` through an SSH
 * tunnel.  Returns the full response (status, headers, body).
 *
 * Returns `null` on connection error, timeout, or if the executor
 * doesn't support tunnelling.
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

  let tunnel: Duplex;
  try {
    tunnel = await tunnelConnect(serverId, "127.0.0.1", remotePort);
  } catch {
    return null;
  }

  return new Promise<TunnelResponse | null>((resolve) => {
    const timer = setTimeout(() => {
      tunnel.destroy();
      resolve(null);
    }, timeoutMs);

    const req = http.request(
      {
        method,
        path,
        headers: {
          Host: `127.0.0.1:${remotePort}`,
          ...headers,
        },
        createConnection: () => tunnel as any,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );

    req.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    if (body) req.write(body);
    req.end();
  });
}

// ─── Streaming (SSE / chunked) through tunnel ────────────────────────────────

export interface TunnelStreamHandle {
  /** The raw duplex stream — HTTP headers already consumed. */
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
 * Returns `null` on connection error, timeout, or non-2xx status.
 */
export async function tunnelStream(
  serverId: string,
  remotePort: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<TunnelStreamHandle | null> {
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
    let buffer = "";
    const timeout = setTimeout(() => {
      tunnel.destroy();
      resolve(null);
    }, 10_000);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      clearTimeout(timeout);
      tunnel.removeListener("data", onData);

      // Parse status line
      const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
      const statusCode = parseInt(statusLine.split(" ")[1] ?? "0", 10);

      // Parse headers
      const rawHeaders = buffer.slice(buffer.indexOf("\r\n") + 2, headerEnd);
      const headers: Record<string, string> = {};
      for (const line of rawHeaders.split("\r\n")) {
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
        process.nextTick(() => tunnel.emit("data", Buffer.from(body)));
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
 * Forward a remote port to localhost — VS Code SSH-style.
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
        // Port taken — let the OS pick one
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
