/**
 * Raw bidirectional stream for `docker exec` and `docker attach` — a hijack that
 * doesn't go through the HTTP client.
 *
 * WHY THIS EXISTS
 * An interactive shell needs stdin, and dockerode gets that by asking docker-modem
 * for `{hijack: true}`: modem issues the exec-start over `node:http` with an
 * upgrade, then lifts the raw socket out of the response. Under **Bun** that hangs
 * forever — the daemon answers `101 UPGRADED`, Bun's `node:http` doesn't surface
 * the upgrade the way modem expects, and the start promise simply never settles.
 * Measured on Bun 1.3.1 vs Node 22: Node round-trips, Bun never returns.
 *
 * The api ships as a Bun image (and a Bun-compiled desktop binary), so the
 * service terminal could never open there — the WS connected and then sat silent,
 * while the SERVER terminal (ssh2, no HTTP in the path) worked fine. The edge
 * executor dodged the same trap by avoiding hijack entirely, but three callers
 * can't: the service shell, and backup RESTORE (`pipeIntoCommand` +
 * `receiveStream`) which feed the archive to the target's stdin.
 *
 * So we speak the upgrade ourselves on a plain socket: write the HTTP request,
 * read the `101` response head, hand back the socket. Same protocol dockerode
 * uses, minus the runtime's HTTP layer — so it behaves identically on Node and
 * Bun. Works for every transport the daemon is reached through: a unix socket, a
 * TCP port (the SSH bridge is a local port), or TLS.
 */

import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";

/** The connection details dockerode's modem already resolved for us. */
export interface DaemonConnection {
  socketPath?: string;
  host?: string;
  port?: number | string;
  protocol?: string;
  ca?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer | Array<string | Buffer>;
  key?: string | Buffer | Array<string | Buffer>;
}

const HEADER_END = "\r\n\r\n";
/** A daemon that accepts the request answers in milliseconds; this only guards
 *  against a socket that connects and then says nothing. */
const UPGRADE_TIMEOUT_MS = 20_000;

function connect(conn: DaemonConnection): Duplex {
  if (conn.socketPath) return net.connect({ path: conn.socketPath });
  const port = Number(conn.port ?? (conn.protocol === "https" ? 443 : 80));
  const host = conn.host ?? "127.0.0.1";
  if (conn.protocol === "https") {
    return tls.connect({ host, port, ca: conn.ca, cert: conn.cert, key: conn.key });
  }
  return net.connect({ port, host });
}

/**
 * Wrap the upgraded socket in a Duplex whose read buffer ALREADY HOLDS the bytes
 * that rode along with the `101` head — normally the shell's first prompt.
 *
 * Why not `socket.pause()` + `socket.unshift(leftover)`, the obvious version:
 * under **Bun** those bytes are simply gone. A `data` listener attached after the
 * unshift never receives them, so the terminal opens blank and stays blank until
 * the user presses a key. (Measured: Node re-emits the unshifted chunk, Bun drops
 * it.) The api ships as a Bun image and a Bun-compiled desktop binary, so this has
 * to work without relying on unshift semantics at all — and `push()` into a stream
 * we own buffers identically on both runtimes.
 *
 * Contract is unchanged for callers: the stream comes back NOT FLOWING, so attach
 * handlers first and then `resume()` (or pipe).
 */
function bridgeSocket(socket: Duplex, leftover: Buffer): Duplex {
  const out = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, _enc, cb) {
      socket.write(chunk as Buffer, (err) => cb(err ?? null));
    },
    final(cb) {
      if (!socket.destroyed) socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy(err ?? undefined);
      cb(err);
    },
  });

  let readEnded = false;
  const endRead = () => {
    if (readEnded) return;
    readEnded = true;
    out.push(null);
  };

  if (leftover.length > 0) out.push(leftover);

  socket.on("data", (chunk: Buffer) => {
    if (!out.push(chunk)) socket.pause();
  });
  socket.on("end", endRead);
  socket.on("error", (err: Error) => out.destroy(err));
  // A raw socket emits `close` however it dies, and the consumer keys its
  // exit-code lookup off that event. Finish BOTH sides here so autoDestroy emits
  // the duplex's own `close` — it fires after `end`, so a final burst of output
  // still reaches the caller instead of being cut off by an eager destroy().
  socket.on("close", () => {
    endRead();
    if (!out.writableEnded) out.end();
  });

  return out;
}

/**
 * Perform the `Connection: Upgrade` handshake against one daemon endpoint and
 * hand back the raw duplex. Shared by exec-start and container-attach: both are
 * the same protocol, and both hang (or 101-error) through docker-modem's hijack.
 *
 * The returned stream is not flowing and any output that shared a packet with the
 * `101` head is already buffered in it, so the caller attaches its handlers and
 * then calls `resume()` (or pipes). See {@link bridgeSocket}.
 */
function upgradeRequest(conn: DaemonConnection, path: string, body: string): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = connect(conn);
    let settled = false;
    let head: Buffer = Buffer.alloc(0);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`docker exec upgrade timed out after ${UPGRADE_TIMEOUT_MS}ms`)),
      UPGRADE_TIMEOUT_MS,
    );

    const onData = (chunk: Buffer) => {
      if (settled) return;
      head = head.length === 0 ? Buffer.from(chunk) : Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      const end = text.indexOf(HEADER_END);
      if (end === -1) {
        // Bound the head we're willing to buffer — a non-daemon listener could
        // otherwise stream forever while we wait for a blank line.
        if (head.length > 64 * 1024) fail(new Error("docker exec upgrade: response head too large"));
        return;
      }

      const statusLine = text.slice(0, text.indexOf("\r\n"));
      // Docker answers `101 UPGRADED` to the upgrade request. Anything else (400,
      // 404 for a vanished exec, 409) is a real error and its body is the reason.
      if (!/ 101 /.test(statusLine)) {
        const reason = text.slice(end + HEADER_END.length).trim();
        fail(new Error(`docker ${path} failed: ${statusLine}${reason ? ` — ${reason}` : ""}`));
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.removeListener("close", onEarlyClose);

      // Bytes that arrived in the same packet as the header are already shell
      // output; the bridge hands them to the caller instead of dropping them.
      const headBytes = Buffer.byteLength(text.slice(0, end + HEADER_END.length), "latin1");
      resolve(bridgeSocket(socket, head.subarray(headBytes)));
    };

    const onEarlyClose = () =>
      fail(new Error(`docker ${path}: connection closed before upgrade`));

    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onEarlyClose);

    // Unversioned path: the daemon accepts it and we don't have to track which
    // API version the modem negotiated.
    socket.write(
      `POST ${path} HTTP/1.1\r\n` +
        `Host: ${conn.socketPath ? "localhost" : (conn.host ?? "localhost")}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: tcp\r\n\r\n` +
        body,
    );
  });
}

/**
 * Start an exec and return the duplex carrying its bytes.
 *
 * `execId` comes from a normal `container.exec(...)` call — creating the exec is
 * an ordinary POST that works fine on every runtime; only the *start* needs this
 * treatment.
 */
export function startExecStream(
  conn: DaemonConnection,
  execId: string,
  opts: { tty: boolean; stdin: boolean },
): Promise<Duplex> {
  return upgradeRequest(
    conn,
    `/exec/${execId}/start`,
    JSON.stringify({ Detach: false, Tty: opts.tty }),
  );
}

/**
 * Attach to a container and return the duplex carrying its bytes — the
 * `/containers/{id}/attach` sibling of {@link startExecStream}.
 *
 * Needed for the restore helper, which feeds a tar stream to the container's
 * stdin: dockerode's only stdin-capable attach is `{hijack: true}`, and under Bun
 * that resolves through modem's `response` path with `(HTTP code 101) unexpected`
 * instead of the socket, so no restore could ever write a byte.
 */
export function startAttachStream(
  conn: DaemonConnection,
  containerId: string,
  opts: { stdin: boolean; stdout: boolean; stderr: boolean },
): Promise<Duplex> {
  const q = new URLSearchParams({
    stream: "1",
    stdin: opts.stdin ? "1" : "0",
    stdout: opts.stdout ? "1" : "0",
    stderr: opts.stderr ? "1" : "0",
  });
  return upgradeRequest(conn, `/containers/${containerId}/attach?${q.toString()}`, "");
}

/**
 * Read the connection details back off a dockerode instance's modem, so the raw
 * upgrade goes to the SAME daemon (unix socket, the SSH bridge's local port, or
 * TLS) the rest of the runtime is already talking to. Avoids re-resolving — and
 * re-standing-up — the transport.
 */
export function daemonConnectionFrom(docker: { modem?: unknown }): DaemonConnection {
  const m = (docker.modem ?? {}) as Record<string, unknown>;
  return {
    socketPath: typeof m.socketPath === "string" ? m.socketPath : undefined,
    host: typeof m.host === "string" ? m.host : undefined,
    port: typeof m.port === "number" || typeof m.port === "string" ? m.port : undefined,
    protocol: typeof m.protocol === "string" ? m.protocol : undefined,
    ca: m.ca as DaemonConnection["ca"],
    cert: m.cert as DaemonConnection["cert"],
    key: m.key as DaemonConnection["key"],
  };
}
