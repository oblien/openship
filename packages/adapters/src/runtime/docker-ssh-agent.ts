import net from "node:net";
import type { Duplex } from "node:stream";

import {
  attachDialStdioDiagnostics,
  connectSshClient,
  dialStdioDiagnostics,
  execSshCommand,
  openSshUnixSocket,
  openDockerDialStdioChannel,
  DOCKER_DIAL_STDIO_COMMAND,
  type StreamLocalCapableClient,
} from "../system/ssh-client";
import type { SshConfig, CommandExecutor } from "../types";
import type { DockerConnectionOptions } from "./docker-transport";
import { safeErrorMessage, withTimeout } from "@repo/core";

const DEFAULT_REMOTE_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const resolvedDockerSocketPathCache = new WeakMap<DockerConnectionOptions, Promise<string>>();

// Per-CHANNEL data-flow verification for a real bridge request (see
// `bridgeClient`) and for the one-time capability probe. The probe only proves
// the FIRST channel on a connection can move data; some sshd/ssh2 combinations
// then open every later channel "dead" (open resolves, no byte ever crosses).
// Bound both the open and the first-byte wait with this — deliberately short so
// most of the caller's reachability budget (e.g. the 25s migration-scan cap) is
// left for the dial-stdio fallback to complete when a channel proves dead.
const STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS = 3_000;
// How long a dial-stdio channel may say nothing before we commit the socket to it anyway.
// NOT a verification gate — there is no transport left to fall back to. It is a REPORTING
// window: a channel that dies in the first seconds (no dockerd, no permission, a forced
// command) does so before this expires, and catching it here lets the request be answered
// with the daemon's own words. Expiring costs nothing — a silent channel is committed, and
// data already flows client→upstream through the capture while we wait.
const DIAL_STDIO_ANSWER_TIMEOUT_MS = 3_000;
// Cap on the client request buffered while choosing/verifying an upstream. A
// real Docker API request that gets a response verifies on the first response
// byte, long before this; the cap is only a safety valve against unbounded
// memory on a large streaming upload. On overflow we COMMIT to the current
// channel rather than fall back — replaying a truncated buffer would corrupt the
// request, and a request big enough to overflow is plainly being serviced.
const VERIFY_BUFFER_CAP_BYTES = 8 * 1024 * 1024;

function toSshConfig(opts: DockerConnectionOptions): SshConfig {
  return {
    host: opts.host ?? "",
    port: opts.port ?? 22,
    username: opts.username,
    hostVerifier: opts.hostVerifier,
    password: opts.password,
    privateKey: opts.privateKey,
    privateKeyPassphrase: opts.privateKeyPassphrase,
    sshAgent: opts.sshAgent,
  };
}

function getConfiguredDockerSocketPath(opts: DockerConnectionOptions): string | null {
  const socketPath = opts.dockerSocketPath?.trim();
  return socketPath ? socketPath : null;
}

function normalizeSocketPathLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const line of lines) {
    const socketPath = line.trim();
    if (!socketPath.startsWith("/")) {
      continue;
    }
    if (seen.has(socketPath)) {
      continue;
    }
    seen.add(socketPath);
    normalized.push(socketPath);
  }

  return normalized;
}

const DOCKER_SOCKET_DISCOVERY_SCRIPT = [
  "set -eu",
  'uid="$(id -u 2>/dev/null || printf 0)"',
  'printf "%s\\n" "/var/run/docker.sock" "/run/docker.sock" "/run/podman/podman.sock" "/run/user/$uid/docker.sock" "$HOME/.docker/run/docker.sock" | while IFS= read -r candidate; do if [ -S "$candidate" ]; then printf "%s\\n" "$candidate"; fi; done',
  'find /run/user -maxdepth 2 -type s \\( -name docker.sock -o -name podman.sock \\) -print 2>/dev/null || true',
  'for dir in /run /var/run "$HOME/.docker/run"; do',
  '  if [ -d "$dir" ]; then',
  '    find "$dir" -maxdepth 3 -type s \\( -name docker.sock -o -name podman.sock \\) -print 2>/dev/null || true',
  "  fi",
  "done",
].join("\n");

async function discoverRemoteDockerSocketPathsWithClient(
  client: StreamLocalCapableClient,
): Promise<string[]> {
  const result = await execSshCommand(client, DOCKER_SOCKET_DISCOVERY_SCRIPT);
  const lines = [result.stdout, result.stderr]
    .filter(Boolean)
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);

  return normalizeSocketPathLines(lines);
}

/** Throws rather than answering `[]`: see {@link resolveRemoteDockerSocketPath} for why a
 *  refused probe must not read as "this box has no docker socket". */
async function discoverRemoteDockerSocketPathsWithExecutor(
  executor: CommandExecutor,
): Promise<string[]> {
  const output = await executor.exec(DOCKER_SOCKET_DISCOVERY_SCRIPT, { timeout: 10_000 });
  return normalizeSocketPathLines(output.split(/\r?\n/));
}

async function discoverRemoteDockerSocketPaths(
  opts: DockerConnectionOptions,
): Promise<string[]> {
  // Use pooled executor when available - no extra SSH connection needed
  if (opts.executor) {
    return discoverRemoteDockerSocketPathsWithExecutor(opts.executor);
  }

  let conn: StreamLocalCapableClient | null = null;

  try {
    conn = await connectSshClient(toSshConfig(opts));
    return await discoverRemoteDockerSocketPathsWithClient(conn);
  } finally {
    conn?.end();
  }
}

async function resolveRemoteDockerSocketPath(
  opts: DockerConnectionOptions,
): Promise<string> {
  const configuredSocketPath = getConfiguredDockerSocketPath(opts);
  if (configuredSocketPath) {
    return configuredSocketPath;
  }

  const cachedPath = resolvedDockerSocketPathCache.get(opts);
  if (cachedPath) {
    return cachedPath;
  }

  // A probe that ANSWERED is a reading worth caching — including "no socket anywhere,
  // so use the default". A probe that FAILED is not: the transport blipped, the command
  // timed out, or an sshd forced command ran instead of our script. Falling back to the
  // default is still right for this call, but CACHING that fallback pins it for the
  // whole lifetime of `opts`, so one blip against a rootless or podman-only host keeps
  // aiming every later attempt at /var/run/docker.sock with no re-probe. Un-poison
  // instead — the rejection handler is a microtask, so it always runs after the `set`
  // below, and a concurrent caller holding this same promise still gets the default.
  const pendingPath = discoverRemoteDockerSocketPaths(opts).then(
    (paths) => paths[0] ?? DEFAULT_REMOTE_DOCKER_SOCKET_PATH,
    () => {
      resolvedDockerSocketPathCache.delete(opts);
      return DEFAULT_REMOTE_DOCKER_SOCKET_PATH;
    },
  );

  resolvedDockerSocketPathCache.set(opts, pendingPath);
  return pendingPath;
}

/** A loopback TCP listener that tunnels Docker API traffic to the remote socket. */
export interface DockerSshBridge {
  /** Bind the listener and return the loopback address dockerode should target. */
  start(): Promise<{ host: string; port: number }>;
  /** Decide + cache the upstream transport (streamlocal vs dial-stdio) up front.
   *  Used by the transport preflight so reachability fails fast with the right
   *  transport already chosen. Safe to call repeatedly (memoized). */
  probe(): Promise<void>;
  /** Tear down the listener and any live connections. */
  close(): void;
}

/**
 * Open a duplex stream to the remote Docker socket over SSH streamlocal
 * forwarding. Pooled path reuses the executor's persistent SSH connection
 * (channel multiplexing, no new TCP connection); ephemeral path opens a
 * fresh SSH connection whose lifetime is tied to the channel.
 *
 * This is the ORIGINAL transport — kept as the preferred path where it works
 * (dev/Node). The bridge falls through to dial-stdio when this can't open (the
 * Bun-compiled desktop runtime, or an sshd with streamlocal forwarding off).
 */
async function openStreamlocalUpstream(opts: DockerConnectionOptions): Promise<Duplex> {
  const socketPath = await resolveRemoteDockerSocketPath(opts);

  if (opts.executor?.forwardUnixSocket) {
    return opts.executor.forwardUnixSocket(socketPath);
  }

  const client: StreamLocalCapableClient = await connectSshClient(toSshConfig(opts));
  try {
    const channel = await openSshUnixSocket(client, socketPath);
    channel.once("close", () => client.end());
    channel.on("error", () => client.end());
    return channel;
  } catch (error) {
    client.end();
    throw error;
  }
}

/**
 * Answer a bridged request with a real HTTP 502 carrying `reason`.
 *
 * This is the whole point of the file's error handling. A destroyed socket cannot carry a
 * cause: dockerode sees a bare reset and reports `socket hang up`, so a server with no
 * running dockerd, an unreachable socket, or an sshd ForceCommand all arrived as the same
 * four words. docker-modem parses a non-stream JSON body and renders
 * `(HTTP code 502) unexpected - <message>`, so the reason written here is the message the
 * operator finally reads.
 *
 * Only valid while NOTHING has been written client-ward yet — appending a status line to a
 * response already in flight would corrupt it. Every caller tracks that (`answered`).
 */
function respondBadGateway(client: net.Socket, reason: string): void {
  if (client.destroyed || client.writableEnded) {
    client.destroy();
    return;
  }
  const body = JSON.stringify({ message: reason });
  try {
    client.end(
      "HTTP/1.1 502 Bad Gateway\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n" +
        "\r\n" +
        body,
    );
  } catch {
    // Peer already gone — nothing to tell anyone.
    client.destroy();
  }
}

/** Bidirectional pipe between dockerode's TCP socket and the SSH upstream,
 *  propagating backpressure + end/close both ways. Terminal — call once. */
function pipeThrough(
  client: net.Socket,
  upstream: Duplex,
  handoff: { answered: boolean; unansweredReason: () => string },
): void {
  let answered = handoff.answered;
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", teardown);
  // NOT `teardown`. An upstream error is the most common way a bridged request fails —
  // sshd's ForceCommand exiting 142, `docker` missing, the exec channel dying — and
  // `teardown` destroyed the CLIENT, which is the one socket the cause has to travel
  // down. `respondBadGateway` refuses a destroyed socket, so the `close` handler below
  // then answered nothing and dockerode got the bare `socket hang up` this whole path
  // exists to eliminate. The 502 was only ever reachable on a *clean* unanswered close.
  //
  // Answer here rather than leaving it to `close`: under Node `close` follows `error`,
  // but this file documents three Bun-only stream divergences and an unanswered request
  // hanging is worse than a duplicate attempt — `respondBadGateway` is idempotent
  // (`writableEnded` short-circuits it), so the `close` path staying as-is costs nothing.
  upstream.on("error", () => {
    if (!answered) respondBadGateway(client, handoff.unansweredReason());
    upstream.destroy();
  });
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => {
    // An upstream that closes without ever answering is a FAILED request, and the
    // failure has a cause the upstream usually stated (see `dialStdioDiagnostics`).
    // Say it, rather than destroying the socket and letting dockerode guess.
    if (!answered) {
      respondBadGateway(client, handoff.unansweredReason());
      return;
    }
    // `end`, not `destroy`: the response may still be buffered client-ward, and
    // destroy() discards it — a truncated `docker logs` / image pull reported as a
    // reset instead of the bytes we already had.
    if (!client.destroyed) client.end();
  });
  // Before the pipes: a second `data` listener alongside `pipe()` fires under both
  // Node and Bun (verified), and attaching it first means no byte can slip past
  // between the two statements.
  upstream.on("data", () => {
    answered = true;
  });
  client.pipe(upstream);
  // `{ end: false }` because pipe's default ends the socket's WRITABLE side on upstream
  // EOF, and `respondBadGateway` cannot write to an ended socket — EOF is exactly how an
  // unanswered channel finishes, so the default swallowed the 502 that explains it. The
  // success path still ends at EOF, below, where `answered` is already known.
  upstream.pipe(client, { end: false });
  upstream.once("end", () => {
    if (answered && !client.writableEnded) client.end();
  });
}

/**
 * What `upstream` did with the first response byte.
 *
 * Three arms, not two, because *closed* and *silent* are opposite evidence:
 *   • `closed` — it ended or errored without answering. That is proof of failure, and the
 *     cause is on the stream.
 *   • `silent` — nothing yet, within our window. Proof of nothing: `/events`,
 *     `/containers/{id}/wait` and a long `docker build` upload legitimately say nothing for
 *     minutes. Collapsing this into the same `null` as `closed` is how a working long-poll
 *     would get torn down as a dead channel.
 *
 * The proving chunk is RETURNED (not re-injected) so the caller can write it straight to the
 * client before attaching the pipe — the pipe only carries what arrives after it attaches,
 * and `unshift`-then-`pipe` proved unreliable under the Bun runtime (the byte was silently
 * dropped).
 */
type FirstByte =
  | { kind: "data"; chunk: Buffer }
  | { kind: "closed" }
  | { kind: "silent" };

function awaitFirstByte(upstream: Duplex, ms: number): Promise<FirstByte> {
  return new Promise((resolve) => {
    const finish = (outcome: FirstByte) => {
      clearTimeout(timer);
      upstream.removeListener("data", onData);
      upstream.removeListener("error", onFail);
      upstream.removeListener("close", onFail);
      resolve(outcome);
    };
    const onData = (chunk: Buffer) => finish({ kind: "data", chunk });
    const onFail = () => finish({ kind: "closed" });
    const timer = setTimeout(() => finish({ kind: "silent" }), ms);
    upstream.on("data", onData);
    upstream.once("error", onFail);
    upstream.once("close", onFail);
  });
}

/**
 * Does this look like the start of an HTTP response, allowing for a chunk shorter than the
 * marker? Anything else on a dial-stdio channel is a shell talking to us instead of the
 * Docker daemon — an sshd ForceCommand banner (`Please login as the user "ec2-user"…`), a
 * login MOTD, `docker: command not found`. Piped through, those become a body dockerode
 * cannot parse; named here, they become the actual error.
 *
 * Not applied to streamlocal: sshd forwards that socket itself, so no shell can intercept
 * it, and a non-HTTP answer there means the discovered socket isn't Docker's.
 */
function looksLikeHttpResponse(chunk: Buffer): boolean {
  const marker = "HTTP/";
  const head = chunk.subarray(0, marker.length).toString("latin1");
  return marker.startsWith(head) || head.startsWith(marker);
}

/** Everything the operator can do about any of these, said once. */
const BRIDGE_FAILURE_HINT =
  "Check that Docker is installed and running on the server (`docker info`) and that the SSH user can reach its socket.";

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The message dockerode's caller ends up reading. `cause` is the part we actually know. */
function bridgeFailureReason(opts: DockerConnectionOptions, cause: string): string {
  const host = opts.host?.trim() || "the remote host";
  return `Could not reach the Docker daemon on ${host} over SSH: ${sentence(cause)} ${BRIDGE_FAILURE_HINT}`;
}

/**
 * Why an upstream that closed without answering closed — in its own words when it left any
 * (dial-stdio writes the daemon's refusal to stderr), and otherwise as the plain fact.
 */
function upstreamClosedReason(
  opts: DockerConnectionOptions,
  upstream: Duplex,
  transport: string,
): string {
  return bridgeFailureReason(
    opts,
    dialStdioDiagnostics(upstream) || `the ${transport} channel closed before answering the request`,
  );
}

/** Methods with no side effect, so re-sending one to the daemon costs only a channel. */
const REPLAY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * May the request buffered in `chunks` be sent to a SECOND upstream?
 *
 * Downgrading transports replays the buffer, and the buffer has already been written to the
 * first upstream — so a replay is a second EXECUTION, not a retry. Read-only methods are
 * free; `POST /containers/{id}/restart` restarts the container twice. An empty buffer is
 * free too: the client hasn't spoken yet, so nothing was dispatched. Anything unrecognised
 * (including a request line split across chunks) is treated as unsafe — the cost of being
 * wrong here is a duplicated mutation on someone's server.
 */
function requestIsReplaySafe(chunks: Buffer[]): boolean {
  // The first chunk with bytes in it, not `chunks[0]`: nothing filters zero-length pushes
  // on the way in, and an empty leading chunk would read as "hasn't spoken yet" and answer
  // SAFE for a request whose method is sitting in the next one — permissive in the one
  // function that exists to be conservative.
  const head = chunks.find((c) => c.length > 0);
  if (!head) return true;
  const space = head.indexOf(0x20);
  if (space <= 0) return false;
  return REPLAY_SAFE_METHODS.has(head.subarray(0, space).toString("latin1"));
}

/**
 * Start consuming an accepted bridge socket SYNCHRONOUSLY and buffer what it
 * sends until an upstream is chosen.
 *
 * This is bug #1's fix: under the Bun-hosted API a freshly-accepted socket whose
 * first `data` listener is attached even ~50ms late silently drops dockerode's
 * request (the bytes never reach the wire). So the listener is attached here,
 * before `bridgeClient` does any `await`. `feed` replays the buffer onto a
 * candidate and forwards the rest live; `stop` detaches from a dead candidate
 * before we abandon it; `commit`/`fail` are the terminal handoff.
 */
function captureClient(client: net.Socket) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;
  let closed = false;
  let live: Duplex | null = null;

  const onData = (chunk: Buffer) => {
    if (live) live.write(chunk);
    if (overflowed) return;
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes >= VERIFY_BUFFER_CAP_BYTES) {
      // Bound the in-memory buffer WITHOUT dropping the tail (dropping would
      // corrupt the request): pause the socket so the OS holds the rest via TCP
      // backpressure until `commit`'s pipe resumes it. `overflowed` also routes a
      // request this large straight to commit-without-verify — a server won't
      // answer a first response byte until the whole body is in, so first-byte
      // verification would false-negative on a big upload.
      overflowed = true;
      client.pause();
    }
  };
  const onGone = () => {
    closed = true;
  };
  client.on("data", onData);
  client.once("error", onGone);
  client.once("close", onGone);

  const detach = () => {
    client.removeListener("data", onData);
    client.removeListener("error", onGone);
    client.removeListener("close", onGone);
  };

  return {
    get closed() {
      return closed;
    },
    get overflowed() {
      return overflowed;
    },
    /** Whether this request may be handed to a second upstream — see
     *  `requestIsReplaySafe`. Read at the moment of the decision, not at capture time. */
    get replaySafe() {
      return requestIsReplaySafe(chunks);
    },
    /** Replay everything buffered so far onto `upstream` and forward the rest
     *  live. Calling it again on a different upstream (the fallback) replays the
     *  whole buffer — complete, because nothing is dropped until `commit`, but a
     *  second dispatch to the daemon: gate that on `replaySafe`. */
    feed(upstream: Duplex): void {
      for (const chunk of chunks) upstream.write(chunk);
      live = upstream;
    },
    /** Stop forwarding to the current upstream (keep buffering) — used before
     *  destroying a dead channel so late bytes never hit a torn-down stream. */
    stop(): void {
      live = null;
    },
    /** Terminal: detach and hand the socket to the (already-fed) `upstream` via a
     *  bidi pipe, or destroy it if the client already went away. `handoff` tells the
     *  pipe whether a response byte has already been forwarded, and what to say if
     *  the upstream closes without ever producing one. */
    commit(upstream: Duplex, handoff: Parameters<typeof pipeThrough>[2]): void {
      detach();
      chunks.length = 0;
      if (closed) {
        upstream.destroy();
        return;
      }
      pipeThrough(client, upstream, handoff);
    },
    /** Terminal: no usable upstream. Answer the request with `reason` (a real HTTP
     *  502 — see `respondBadGateway`) instead of destroying the socket, which is
     *  what turned every one of these into `socket hang up`.
     *
     *  Written BEFORE detach so the socket still has an error listener during the
     *  write, and never with `destroy(err)`: a server-side socket cannot transmit a
     *  JS Error to its peer, and destroy(err) emits a local 'error' event that —
     *  once detach() has removed this socket's listener — would be unhandled and
     *  take down the process over one dead Docker request. */
    fail(reason: string): void {
      respondBadGateway(client, reason);
      detach();
    },
  };
}

/**
 * Build a Docker transport bridge for the SSH connection.
 *
 * dockerode talks plain HTTP to a loopback TCP port; each accepted
 * connection is piped to a fresh streamlocal channel to the remote Docker
 * socket. This is deliberately a real TCP listener rather than a custom
 * `http.Agent.createConnection` (the previous approach): Bun's HTTP client
 * ignores `Agent.createConnection` and dials the placeholder host instead,
 * which broke every SSH-transport Docker call under the Bun-hosted API. A
 * loopback bridge is honored identically by Node and Bun.
 */
export function createDockerSshBridge(opts: DockerConnectionOptions): DockerSshBridge {
  const clients = new Set<net.Socket>();

  // Upstream transport, decided ONCE per bridge and cached:
  //   • "streamlocal" — SSH unix-socket forwarding (the original path; works in
  //     dev/Node, so that path is untouched).
  //   • "dialstdio"   — the Docker API over a `docker system dial-stdio` exec
  //     channel; used when streamlocal can't open (Bun-compiled desktop, or an
  //     sshd with `AllowStreamLocalForwarding no`). Same transport that the
  //     remote `docker build` already uses successfully.
  let upstreamMode: "streamlocal" | "dialstdio" | null = null;
  let modeDecision: Promise<"streamlocal" | "dialstdio"> | null = null;
  // Dedicated SSH client for the ephemeral dial-stdio path (no pooled executor).
  // Reused across channels for the bridge's lifetime; closed in close().
  let dialClient: StreamLocalCapableClient | null = null;
  // Set once a streamlocal channel opens but proves dead (see `bridgeClient`):
  // some sshd/ssh2 combinations only reliably service the FIRST channel on a
  // connection, so once the pooled one has shown that, every dial-stdio channel
  // for the rest of this bridge's life opens on a fresh ephemeral connection
  // instead of risking the same fate on the already-one-channel-deep pooled one.
  let pooledUnreliable = false;

  /**
   * @param forceEphemeral Skip the pooled executor and open a dedicated SSH
   *   connection instead — the post-dead-channel fallback (see `bridgeClient`).
   *   A fresh connection's first channel has been reliable in every case
   *   observed, at the cost of one extra SSH handshake.
   */
  const openDialStdioUpstream = async (forceEphemeral = false): Promise<Duplex> => {
    // Pooled executor path: same connection + env/PATH as the working build.
    // `attachDialStdioDiagnostics` is idempotent — the pooled SshExecutor already
    // attached it; any other executor implementation gets its error floor here.
    if (!forceEphemeral && opts.executor?.openDockerDialStdio) {
      return attachDialStdioDiagnostics(await opts.executor.openDockerDialStdio());
    }
    // Ephemeral path: one dedicated SSH client, channel-multiplexed. Reset the
    // handle if the connection drops so the next call reconnects.
    if (!dialClient) {
      const client = await connectSshClient(toSshConfig(opts));
      client.once("close", () => {
        if (dialClient === client) dialClient = null;
      });
      dialClient = client;
    }
    return openDockerDialStdioChannel(dialClient);
  };

  /**
   * Serve the captured request over a dial-stdio channel.
   *
   * The terminal transport — there is nothing left to fall back to — so unlike the
   * streamlocal path this REPORTS instead of downgrading. Two things are worth catching
   * before committing the socket to a pipe, because both are silent otherwise:
   *
   *   • the channel closes without answering — dockerd not running, socket permission,
   *     `docker: command not found`. The daemon said which; `dialStdioDiagnostics` has it.
   *   • the first bytes aren't HTTP — a forced command or login banner answered instead of
   *     the daemon (the `Please login as the user "ec2-user"` AMI key).
   *
   * A merely *silent* channel is committed, not failed: `/events`, `/containers/{id}/wait`
   * and a large build upload all answer nothing for minutes, and `pipeThrough` still reports
   * an unanswered close whenever it eventually comes.
   */
  const serveDialStdio = async (
    capture: ReturnType<typeof captureClient>,
    client: net.Socket,
    upstream: Duplex,
  ): Promise<void> => {
    capture.feed(upstream);
    // overflow ⇒ a large upload is plainly being serviced; don't wait on a first byte
    // that cannot arrive until the body is fully in (see VERIFY_BUFFER_CAP_BYTES).
    const first: FirstByte = capture.overflowed
      ? { kind: "silent" }
      : await awaitFirstByte(upstream, DIAL_STDIO_ANSWER_TIMEOUT_MS);
    // NOTHING may await from here to the commit/fail below: the first-byte listener is
    // detached, so a chunk arriving before the pipe attaches would be dropped.

    if (first.kind === "closed") {
      capture.stop();
      upstream.destroy();
      capture.fail(upstreamClosedReason(opts, upstream, DOCKER_DIAL_STDIO_COMMAND));
      return;
    }

    if (first.kind === "data" && !looksLikeHttpResponse(first.chunk)) {
      capture.stop();
      upstream.destroy();
      const banner = first.chunk.toString("utf8").trim().replace(/\s+/g, " ").slice(0, 300);
      capture.fail(
        bridgeFailureReason(
          opts,
          `the SSH session answered ${JSON.stringify(banner)} instead of a Docker API response — ` +
            `something on the remote account (an sshd forced command, or a login banner) is ` +
            `intercepting \`${DOCKER_DIAL_STDIO_COMMAND}\``,
        ),
      );
      return;
    }

    if (first.kind === "data") client.write(first.chunk);
    capture.commit(upstream, {
      answered: first.kind === "data",
      unansweredReason: () => upstreamClosedReason(opts, upstream, DOCKER_DIAL_STDIO_COMMAND),
    });
  };

  const decideMode = async (): Promise<"streamlocal" | "dialstdio"> => {
    // Probe streamlocal by actually MOVING DATA, not just opening the channel:
    // some sshd setups accept the streamlocal channel request but never service
    // it (e.g. AllowStreamLocalForwarding restrictions), so an open-only probe
    // wrongly "passes" and every real Docker request then hangs. Send a tiny
    // Docker `/_ping` and require a response within the window; no data → fall
    // back to `docker system dial-stdio` over an exec channel (the transport the
    // remote `docker build` already uses successfully).
    let probe: Duplex | null = null;
    try {
      probe = await withTimeout(
        openStreamlocalUpstream(opts),
        STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS,
        `streamlocal open timed out after ${STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS / 1000}s`,
      );
      const stream = probe;
      const flowed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS);
        const settle = (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        };
        stream.once("data", () => settle(true)); // any byte back = data flows
        stream.once("error", () => settle(false));
        stream.once("close", () => settle(false));
        try {
          stream.write("GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n");
        } catch {
          settle(false);
        }
      });
      if (flowed) {
        console.log(`[docker-ssh] upstream=streamlocal (${opts.host ?? "?"})`);
        return "streamlocal";
      }
      console.warn(
        `[docker-ssh] upstream=dial-stdio (${opts.host ?? "?"}) — streamlocal opened but no data flowed (Bun/ssh2)`,
      );
      return "dialstdio";
    } catch (err) {
      console.warn(
        `[docker-ssh] upstream=dial-stdio (${opts.host ?? "?"}) — streamlocal unavailable: ${safeErrorMessage(err)}`,
      );
      return "dialstdio";
    } finally {
      probe?.destroy();
    }
  };

  const ensureMode = (): Promise<"streamlocal" | "dialstdio"> => {
    if (upstreamMode) return Promise.resolve(upstreamMode);
    modeDecision ??= decideMode().then((mode) => (upstreamMode = mode));
    return modeDecision;
  };

  /** Abandon streamlocal for this bridge permanently and serve `capture`'s
   *  buffered request over a fresh dial-stdio channel. */
  const downgradeToDialStdio = async (
    capture: ReturnType<typeof captureClient>,
    client: net.Socket,
    reason: string,
  ): Promise<void> => {
    console.warn(
      `[docker-ssh] streamlocal unusable (${opts.host ?? "?"}): ${reason} — ` +
        "downgrading this bridge to dial-stdio (fresh connection) and replaying the buffered request.",
    );
    upstreamMode = "dialstdio";
    pooledUnreliable = true;
    await serveDialStdio(capture, client, await openDialStdioUpstream(true));
  };

  /**
   * Attach one accepted bridge socket to a verified upstream.
   *
   * Buffering of the client request starts SYNCHRONOUSLY in `captureClient`
   * (bug #1 — a Bun-hosted API drops the request if the socket isn't read almost
   * immediately). This then picks the transport and, for streamlocal, proves the
   * specific channel actually carries data before committing — falling back to
   * dial-stdio and replaying the buffered request if it doesn't (bug #2:
   * open-but-dead channels on some sshd/ssh2 combos). dial-stdio has no fallback left,
   * so `serveDialStdio` turns the same evidence into a reported cause instead.
   */
  const bridgeClient = async (client: net.Socket): Promise<void> => {
    const capture = captureClient(client);
    try {
      const mode = await ensureMode();

      if (mode === "dialstdio") {
        await serveDialStdio(capture, client, await openDialStdioUpstream(pooledUnreliable));
        return;
      }

      // streamlocal — bound the open itself (it can hang outright, not just open
      // dead), then require a first response byte within the same window.
      let channel: Duplex;
      try {
        channel = await withTimeout(
          openStreamlocalUpstream(opts),
          STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS,
          `channel open timed out after ${STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS / 1000}s`,
        );
      } catch (err) {
        await downgradeToDialStdio(capture, client, safeErrorMessage(err));
        return;
      }

      capture.feed(channel);
      // overflow ⇒ a large upload is plainly being serviced → commit rather than
      // risk a truncated replay (see VERIFY_BUFFER_CAP_BYTES).
      const firstByte: FirstByte = capture.overflowed
        ? { kind: "silent" }
        : await awaitFirstByte(channel, STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS);
      if (capture.overflowed || firstByte.kind === "data") {
        // Forward the proving byte straight to the client — the pipe below only
        // carries bytes that arrive AFTER it attaches — then hand off the rest.
        if (firstByte.kind === "data") client.write(firstByte.chunk);
        capture.commit(channel, {
          answered: firstByte.kind === "data",
          unansweredReason: () => upstreamClosedReason(opts, channel, "streamlocal"),
        });
        return;
      }

      // `silent` is not evidence of a dead channel, and the request is already ON this one:
      // a downgrade replays the buffer, so a `POST /containers/{id}/restart` — silent for
      // the whole stop timeout, well past this window — restarted the container TWICE.
      // Only replay what is free to re-send. Otherwise stay: a slow real response still
      // arrives, and `pipeThrough` reports the cause if the channel dies instead.
      if (firstByte.kind === "silent" && !capture.replaySafe) {
        capture.commit(channel, {
          answered: false,
          unansweredReason: () => upstreamClosedReason(opts, channel, "streamlocal"),
        });
        return;
      }

      capture.stop(); // don't write late bytes to the channel we're about to tear down
      channel.destroy();
      await downgradeToDialStdio(
        capture,
        client,
        firstByte.kind === "closed"
          ? "channel closed before answering"
          : "channel opened but no data flowed",
      );
    } catch (err) {
      console.warn(`[docker-ssh] bridge client failed (${opts.host ?? "?"}): ${safeErrorMessage(err)}`);
      capture.fail(bridgeFailureReason(opts, safeErrorMessage(err)));
    }
  };

  const server = net.createServer((client) => {
    clients.add(client);
    client.setNoDelay(true);
    // Permanent error floor. captureClient attaches its own 'error' listener and
    // then DETACHes it at the transport handoff (commit/fail), so there are
    // moments with zero listeners on this socket. A peer reset — or a fail()-path
    // destroy — in that gap would be an unhandled 'error' event that crashes the
    // whole API process; one dead Docker request must never do that. Real
    // teardown still flows through close/pipeThrough; this only stops the throw.
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    void bridgeClient(client);
  });

  // The listener outlives start()'s transient bind-time 'error' handler; without a
  // permanent floor an accept-time error (EMFILE/ENFILE under fd pressure) would be
  // an unhandled 'error' event and crash the process. Log and keep serving.
  server.on("error", (err) => {
    console.warn(`[docker-ssh] bridge listener error (${opts.host ?? "?"}): ${safeErrorMessage(err)}`);
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        // Loopback only — never expose the remote Docker socket on the network.
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Docker SSH bridge failed to bind a loopback TCP port."));
            return;
          }
          resolve({ host: "127.0.0.1", port: address.port });
        });
      }),
    probe: async () => {
      await ensureMode();
    },
    close: () => {
      for (const client of clients) {
        client.destroy();
      }
      clients.clear();
      dialClient?.end();
      dialClient = null;
      server.close();
    },
  };
}
