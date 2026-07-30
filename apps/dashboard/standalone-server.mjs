// Production entry for the Next.js standalone dashboard that adds WebSocket
// support to the same-origin API proxy. Used wherever the dashboard runs in
// proxy mode (NEXT_PUBLIC_API_PROXY=true): the Docker image and the CLI
// host-process deploy. The desktop app connects to the API directly (no proxy),
// so it keeps running the plain `server.js`.
//
// WHY THIS EXISTS
// The browser reaches the API through the dashboard's own origin under
// `/api/proxy/*`. That proxy is a Next.js App-Router route handler: it forwards
// HTTP with fetch() and strips the hop-by-hop `Upgrade`/`Connection` headers, so
// it can NEVER complete a WebSocket handshake. The server terminal
// (`wss://<host>/api/proxy/api/terminal/ws/<id>`) therefore hangs behind an
// edge, even though the edge itself upgrades the connection fine. (On desktop it
// worked only because the terminal connects straight to the loopback API.)
//
// Next owns the http server's single `upgrade` listener
// (next/dist/server/lib/start-server), and route handlers can't hook it. So the
// fix lives ENTIRELY in this Node process — no edge config, no client change:
// wrap `http.createServer` so that the instant Next builds its server we take
// over `upgrade`, proxy WS under `/api/proxy/*` straight to the internal API
// (INTERNAL_API_URL) — forwarding the handshake, including the one-time terminal
// ticket carried in `Sec-WebSocket-Protocol` and the auth cookies — and delegate
// every other upgrade to Next's own handler untouched. Then start Next as usual.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Grab the CJS `http` singleton so the monkeypatch is visible to Next's own
// `require("http")` inside start-server (ESM named imports are read-only).
const http = require("node:http");

const API_BASE = (
  process.env.INTERNAL_API_URL ||
  process.env.OPENSHIP_LOCAL_API_URL ||
  "http://127.0.0.1:4000"
).replace(/\/+$/, "");

const PROXY_PREFIX = "/api/proxy";

/**
 * Proxy a WebSocket upgrade under `/api/proxy/*` to the internal API, relaying
 * the 101 handshake both ways. e.g. `/api/proxy/api/terminal/ws/<id>` →
 * `<API_BASE>/api/terminal/ws/<id>`.
 */
function proxyUpgrade(req, clientSocket, head) {
  const upstreamPath = req.url.slice(PROXY_PREFIX.length) || "/";
  const target = new URL(API_BASE + upstreamPath);
  const proxyReq = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    // Pass the client's headers verbatim (Upgrade, Connection, Sec-WebSocket-*,
    // Cookie) so the API sees a genuine upgrade + the terminal ticket/session.
    headers: { ...req.headers, host: target.host },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    const headerLines = Object.entries(proxyRes.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    clientSocket.write(statusLine + headerLines + "\r\n\r\n");
    if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);
    if (head && head.length) proxySocket.write(head);

    const teardown = () => {
      proxySocket.destroy();
      clientSocket.destroy();
    };
    proxySocket.on("error", teardown);
    clientSocket.on("error", teardown);
    proxySocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => proxySocket.destroy());
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  proxyReq.on("error", () => clientSocket.destroy());
  proxyReq.end();
}

let wrapped = false;
const origCreateServer = http.createServer.bind(http);
http.createServer = function patchedCreateServer(...args) {
  const server = origCreateServer(...args);
  // Next attaches its single `upgrade` listener synchronously right after this
  // returns. Defer one tick, then take it over: route `/api/proxy/*` WS to the
  // API and delegate everything else to Next's original handler(s). Runs before
  // any real upgrade (server.listen + I/O come later).
  setImmediate(() => {
    if (wrapped) return;
    const nextListeners = server.listeners("upgrade");
    if (nextListeners.length === 0) return; // not Next's main server
    wrapped = true;
    server.removeAllListeners("upgrade");
    server.on("upgrade", (req, socket, head) => {
      if (req.url && req.url.startsWith(PROXY_PREFIX + "/")) {
        try {
          proxyUpgrade(req, socket, head);
        } catch {
          socket.destroy();
        }
        return;
      }
      for (const listener of nextListeners) listener.call(server, req, socket, head);
    });
  });
  return server;
};

// Boot the unmodified Next standalone server (which now creates its http server
// via our patched createServer).
await import("./server.js");
