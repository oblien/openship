/**
 * Raw upgraded streams for `docker exec`, `docker attach`, and BuildKit sessions,
 * without going through the HTTP client.
 *
 * WHY THIS EXISTS
 * An interactive shell needs stdin, and dockerode gets that by asking docker-modem
 * for `{hijack: true}`: modem issues the exec-start over `node:http` with an
 * upgrade, then lifts the raw socket out of the response. Under **Bun** that hangs
 * forever — the daemon answers `101 UPGRADED`, Bun's `node:http` doesn't surface
 * the upgrade the way modem expects, and the start promise simply never settles.
 * BuildKit's `Upgrade: h2c` variant is rejected as `UnrequestedUpgrade` instead.
 * Measured on Bun 1.3.1 vs Node 22: Node round-trips, Bun never returns.
 *
 * The api ships as a Bun image (and a Bun-compiled desktop binary), so the
 * service terminal could never open there — the WS connected and then sat silent,
 * while the SERVER terminal (ssh2, no HTTP in the path) worked fine. The edge
 * executor dodged the same trap by avoiding hijack entirely. The service shell,
 * backup RESTORE (`pipeIntoCommand` + `receiveStream`), and BuildKit's reverse
 * gRPC session cannot avoid the upgraded connection.
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
 * hand back the raw duplex. Shared by exec-start, container-attach, and the
 * BuildKit session: all hang (or 101-error) through docker-modem's hijack on Bun.
 *
 * The returned stream is not flowing and any output that shared a packet with the
 * `101` head is already buffered in it, so the caller attaches its handlers and
 * then calls `resume()` (or pipes). See {@link bridgeSocket}.
 */
interface UpgradeRequestOptions {
  protocol?: "tcp" | "h2c";
  contentType?: string;
  headers?: Record<string, string>;
  timeoutLabel?: string;
}

function upgradeRequest(
  conn: DaemonConnection,
  path: string,
  body: string,
  opts: UpgradeRequestOptions = {},
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = connect(conn);
    let settled = false;
    let head: Buffer = Buffer.alloc(0);
    const protocol = opts.protocol ?? "tcp";
    const timeoutLabel = opts.timeoutLabel ?? "docker exec";

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`${timeoutLabel} upgrade timed out after ${UPGRADE_TIMEOUT_MS}ms`)),
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
        if (head.length > 64 * 1024)
          fail(new Error(`${timeoutLabel} upgrade: response head too large`));
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

    const onEarlyClose = () => fail(new Error(`docker ${path}: connection closed before upgrade`));

    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onEarlyClose);

    // Unversioned path: the daemon accepts it and we don't have to track which
    // API version the modem negotiated.
    const extraHeaders = Object.entries(opts.headers ?? {})
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    const contentType = opts.contentType ? `Content-Type: ${opts.contentType}\r\n` : "";
    socket.write(
      `POST ${path} HTTP/1.1\r\n` +
        `Host: ${conn.socketPath ? "localhost" : (conn.host ?? "localhost")}\r\n` +
        contentType +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: ${protocol}\r\n` +
        extraHeaders +
        `\r\n` +
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
    { contentType: "application/json" },
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
  return upgradeRequest(conn, `/containers/${containerId}/attach?${q.toString()}`, "", {
    contentType: "application/json",
  });
}

/**
 * Open the reverse h2c connection used by Docker's BuildKit session protocol.
 *
 * dockerode normally opens this through `node:http`. Bun rejects Docker's 101
 * response as `UnrequestedUpgrade`, before the real `/build?version=2` request
 * can start (#745). The raw upgrade path above already exists for the same Bun
 * incompatibility on exec/attach; BuildKit needs the identical workaround with
 * `Upgrade: h2c` and its session identity headers.
 */
export function startBuildKitSessionStream(
  conn: DaemonConnection,
  sessionId: string,
  sessionName: string,
): Promise<Duplex> {
  if (!sessionId || /[\r\n]/.test(sessionId) || /[\r\n]/.test(sessionName)) {
    return Promise.reject(new Error("Invalid Docker BuildKit session identity"));
  }
  return upgradeRequest(conn, "/session", "", {
    protocol: "h2c",
    headers: {
      "X-Docker-Expose-Session-Uuid": sessionId,
      "X-Docker-Expose-Session-Name": sessionName,
    },
    timeoutLabel: "Docker BuildKit session",
  });
}

type DockerodeDialOptions = {
  path?: unknown;
  hijack?: unknown;
  headers?: unknown;
  [key: string]: unknown;
};

type DockerodeDialCallback = (error: Error | null, result: unknown) => void;

const patchedBuildKitModems = new WeakSet<object>();

function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== "object") return "";
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : "";
    return value == null ? "" : String(value);
  }
  return "";
}

/**
 * Route only dockerode's BuildKit `/session` upgrade around Bun's `node:http`
 * implementation. dockerode still owns the gRPC auth server and the subsequent
 * build request; ordinary API calls keep using its modem unchanged.
 */
export function installDockerodeBuildKitSessionWorkaround(docker: { modem?: unknown }): void {
  if (!docker.modem || typeof docker.modem !== "object") return;
  const modem = docker.modem as {
    dial?: (options: DockerodeDialOptions, callback?: DockerodeDialCallback) => unknown;
  };
  if (typeof modem.dial !== "function" || patchedBuildKitModems.has(modem)) return;

  const originalDial = modem.dial.bind(modem);
  modem.dial = (options, callback) => {
    const upgrade = headerValue(options.headers, "upgrade");
    if (
      options.path !== "/session" ||
      options.hijack !== true ||
      upgrade.toLowerCase() !== "h2c" ||
      !callback
    ) {
      return originalDial(options, callback);
    }

    const sessionId = headerValue(options.headers, "x-docker-expose-session-uuid");
    const sessionName = headerValue(options.headers, "x-docker-expose-session-name");
    void startBuildKitSessionStream(
      daemonConnectionFrom(docker),
      sessionId,
      sessionName || "openship",
    ).then(
      (socket) => callback(null, socket),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  };
  patchedBuildKitModems.add(modem);
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
