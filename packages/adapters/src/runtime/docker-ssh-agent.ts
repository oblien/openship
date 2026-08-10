import net from "node:net";
import type { Duplex } from "node:stream";

import type { ClientChannel } from "ssh2";

import {
  connectSshClient,
  execSshCommand,
  openSshUnixSocket,
  openSshExecChannel,
  type StreamLocalCapableClient,
} from "../system/ssh-client";
import type { SshConfig, CommandExecutor } from "../types";
import type { DockerConnectionOptions } from "./docker-transport";
import { safeErrorMessage, withTimeout } from "@repo/core";

const DEFAULT_REMOTE_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const resolvedDockerSocketPathCache = new WeakMap<DockerConnectionOptions, Promise<string>>();

// Opening a streamlocal channel to the remote Docker socket can hang FOREVER when
// the SSH server silently refuses forwarding (AllowStreamLocalForwarding no) — the
// request is accepted but never answered. Bound it so reachability fails fast with
// the diagnostic below instead of stalling behind dockerode's 10-minute API timeout.
const DOCKER_STREAMLOCAL_TIMEOUT_MS = 15_000;

// The Docker Engine API carried over a plain SSH exec channel (no streamlocal).
const DOCKER_DIAL_STDIO_COMMAND = "docker system dial-stdio";
// One-time streamlocal capability probe per bridge. Short so the Bun-compiled
// desktop (where streamlocal hangs) falls through to dial-stdio quickly instead
// of stalling behind the 25s reachability cap on every connection.
const STREAMLOCAL_PROBE_TIMEOUT_MS = 8_000;
// Per-CHANNEL data-flow verification for a real bridge request (see
// `bridgeClient`). The one-time probe above only proves the FIRST channel on a
// connection can move data; some sshd/ssh2 combinations then open every later
// channel "dead" (open resolves, no byte ever crosses). Bound both the open and
// the first-byte wait with this — deliberately short so most of the caller's
// reachability budget (e.g. the 25s migration-scan cap) is left for the
// dial-stdio fallback to actually complete when a channel proves dead.
const STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS = 3_000;
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

function getFallbackDockerSocketPath(opts: DockerConnectionOptions): string {
  return getConfiguredDockerSocketPath(opts) ?? DEFAULT_REMOTE_DOCKER_SOCKET_PATH;
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

async function discoverRemoteDockerSocketPathsWithExecutor(
  executor: CommandExecutor,
): Promise<string[]> {
  try {
    const output = await executor.exec(DOCKER_SOCKET_DISCOVERY_SCRIPT, { timeout: 10_000 });
    return normalizeSocketPathLines(output.split(/\r?\n/));
  } catch {
    return [];
  }
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

  const pendingPath = discoverRemoteDockerSocketPaths(opts)
    .then((paths) => paths[0] ?? DEFAULT_REMOTE_DOCKER_SOCKET_PATH)
    .catch(() => DEFAULT_REMOTE_DOCKER_SOCKET_PATH);

  resolvedDockerSocketPathCache.set(opts, pendingPath);
  return pendingPath;
}

function shouldCollectSocketDiagnostics(error: unknown): boolean {
  const message = safeErrorMessage(error);
  return /channel open failure|open failed/i.test(message);
}

function formatSocketDiagnostics(lines: string[]): string {
  if (lines.length === 0) {
    return "";
  }

  return ` Remote diagnostics: ${lines.join("; ")}.`;
}

async function collectDockerSocketDiagnostics(
  opts: DockerConnectionOptions,
  socketPath: string,
): Promise<string[]> {
  let conn: StreamLocalCapableClient | null = null;

  try {
    conn = await connectSshClient(toSshConfig(opts));

    const escapedPath = JSON.stringify(socketPath);
    const command = [
      "set -eu",
      'printf "user=%s\\n" "$(whoami)"',
      'printf "groups=%s\\n" "$(id -Gn 2>/dev/null || true)"',
      `if [ -S ${escapedPath} ]; then`,
      `  printf 'socket=yes path=%s\\n' ${escapedPath}`,
      `  ls -ld ${escapedPath}`,
      "else",
      `  printf 'socket=no path=%s\\n' ${escapedPath}`,
      `  if [ -e ${escapedPath} ]; then ls -ld ${escapedPath}; fi`,
      "fi",
    ].join("\n");

    const result = await execSshCommand(conn, command);
    const lines = [result.stdout, result.stderr]
      .filter(Boolean)
      .flatMap((text) => text.split(/\r?\n/))
      .map((line) => line.trim())
      .filter(Boolean);

    if (result.code !== 0 && lines.length === 0) {
      return [`remote diagnostic exited with code ${result.code}`];
    }

    if (!getConfiguredDockerSocketPath(opts)) {
      const discoveredPaths = await discoverRemoteDockerSocketPathsWithClient(conn).catch(() => []);
      lines.push(
        discoveredPaths.length > 0
          ? `discovered_sockets=${discoveredPaths.join(",")}`
          : "discovered_sockets=none",
      );
    }

    return lines;
  } catch (error) {
    return [
      `remote diagnostic failed: ${safeErrorMessage(error)}`,
    ];
  } finally {
    conn?.end();
  }
}

export async function probeDockerSshBridge(opts: DockerConnectionOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let conn: StreamLocalCapableClient | null = null;

    resolveRemoteDockerSocketPath(opts)
      .then((socketPath) =>
        connectSshClient(toSshConfig(opts)).then((client) => ({ client, socketPath })),
      )
      .then(async ({ client, socketPath }) => {
        conn = client;
        let stream: ClientChannel;

        try {
          stream = await openSshUnixSocket(client, socketPath);
        } catch (error) {
          throw new Error(
            `SSH session established, but opening a streamlocal channel to ${socketPath} failed: ${safeErrorMessage(error)}`,
          );
        }

        stream.once("close", () => {
          client.end();
        });
        stream.end();
        resolve();
      })
      .catch((error) => {
        conn?.end();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

export async function verifyDockerSshBridge(opts: DockerConnectionOptions): Promise<void> {
  const socketPath = await resolveRemoteDockerSocketPath(opts).catch(() => getFallbackDockerSocketPath(opts));

  // Fast path: use pooled executor’s streamlocal to verify
  if (opts.executor?.forwardUnixSocket) {
    try {
      const stream = await withTimeout(
        opts.executor.forwardUnixSocket(socketPath),
        DOCKER_STREAMLOCAL_TIMEOUT_MS,
        `Opening a streamlocal channel to ${socketPath} timed out after ${DOCKER_STREAMLOCAL_TIMEOUT_MS / 1000}s — ` +
          "the SSH server likely disallows streamlocal forwarding (AllowStreamLocalForwarding).",
      );
      stream.destroy();
      return;
    } catch (error) {
      const diagnostics = shouldCollectSocketDiagnostics(error)
        ? formatSocketDiagnostics(await collectDockerSocketDiagnostics(opts, socketPath))
        : "";

      throw new Error(
        `Cannot reach Docker daemon: ${safeErrorMessage(error)}. ` +
          `Current failure: streamlocal tunnel could not be opened for ${socketPath}. ` +
          "Check that the remote Docker-compatible socket exists, the SSH server allows streamlocal forwarding, and the SSH user can access that socket." +
          diagnostics,
      );
    }
  }

  try {
    await probeDockerSshBridge(opts);
  } catch (error) {
    const diagnostics = shouldCollectSocketDiagnostics(error)
      ? formatSocketDiagnostics(await collectDockerSocketDiagnostics(opts, socketPath))
      : "";

    throw new Error(
      `Cannot reach Docker daemon: ${safeErrorMessage(error)}. ` +
        `Preflight steps: SSH login -> resolve remote Docker socket path -> open streamlocal tunnel -> Docker API ping. ` +
        `Current failure: streamlocal tunnel could not be opened for ${socketPath}. ` +
        "Check that the remote Docker-compatible socket exists, the SSH server allows streamlocal forwarding, and the SSH user can access that socket." +
        diagnostics,
    );
  }
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

/** Bidirectional pipe between dockerode's TCP socket and the SSH upstream,
 *  propagating backpressure + end/close both ways. Terminal — call once. */
function pipeThrough(client: net.Socket, upstream: Duplex): void {
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", teardown);
  upstream.on("error", teardown);
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}

/**
 * Resolve with `upstream`'s first byte once it arrives, or `null` on
 * timeout/error/close. The proving chunk is RETURNED (not re-injected) so the
 * caller can write it straight to the client before attaching the pipe — the
 * pipe only carries what arrives after it attaches, and `unshift`-then-`pipe`
 * proved unreliable under the Bun runtime (the byte was silently dropped).
 */
function awaitFirstByte(upstream: Duplex, ms: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const finish = (chunk: Buffer | null) => {
      clearTimeout(timer);
      upstream.removeListener("data", onData);
      upstream.removeListener("error", onFail);
      upstream.removeListener("close", onFail);
      resolve(chunk);
    };
    const onData = (chunk: Buffer) => finish(chunk);
    const onFail = () => finish(null);
    const timer = setTimeout(() => finish(null), ms);
    upstream.on("data", onData);
    upstream.once("error", onFail);
    upstream.once("close", onFail);
  });
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
    /** Replay everything buffered so far onto `upstream` and forward the rest
     *  live. Safe to call again on a different upstream (the fallback): the full
     *  buffer is retained until `commit`, so the replay is complete each time. */
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
     *  bidi pipe, or destroy it if the client already went away. */
    commit(upstream: Duplex): void {
      detach();
      chunks.length = 0;
      if (closed) {
        upstream.destroy();
        return;
      }
      pipeThrough(client, upstream);
    },
    /** Terminal: no usable upstream. Destroy WITHOUT an error argument — a
     *  server-side accepted socket can't transmit a JS Error to the peer anyway
     *  (dockerode only ever sees the reset), and destroy(err) emits a local
     *  'error' event that, now that detach() removed this socket's error
     *  listener, would be unhandled and crash the process. The cause is already
     *  logged by bridgeClient's catch before this runs. */
    fail(): void {
      detach();
      client.destroy();
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
    if (!forceEphemeral && opts.executor?.openDockerDialStdio) {
      const stream = await opts.executor.openDockerDialStdio();
      stream.once("error", (e) =>
        console.warn(`[docker-ssh] dial-stdio channel error: ${safeErrorMessage(e)}`),
      );
      return stream;
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
    return openSshExecChannel(dialClient, DOCKER_DIAL_STDIO_COMMAND);
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
        STREAMLOCAL_PROBE_TIMEOUT_MS,
        `streamlocal open timed out after ${STREAMLOCAL_PROBE_TIMEOUT_MS / 1000}s`,
      );
      const stream = probe;
      const flowed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), STREAMLOCAL_PROBE_TIMEOUT_MS);
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
    reason: string,
  ): Promise<void> => {
    console.warn(
      `[docker-ssh] streamlocal unusable (${opts.host ?? "?"}): ${reason} — ` +
        "downgrading this bridge to dial-stdio (fresh connection) and replaying the buffered request.",
    );
    upstreamMode = "dialstdio";
    pooledUnreliable = true;
    const upstream = await openDialStdioUpstream(true);
    capture.feed(upstream);
    capture.commit(upstream);
  };

  /**
   * Attach one accepted bridge socket to a verified upstream.
   *
   * Buffering of the client request starts SYNCHRONOUSLY in `captureClient`
   * (bug #1 — a Bun-hosted API drops the request if the socket isn't read almost
   * immediately). This then picks the transport and, for streamlocal, proves the
   * specific channel actually carries data before committing — falling back to
   * dial-stdio and replaying the buffered request if it doesn't (bug #2:
   * open-but-dead channels on some sshd/ssh2 combos). dial-stdio is a plain exec
   * channel (the transport `docker build` already uses), so it isn't re-verified.
   */
  const bridgeClient = async (client: net.Socket): Promise<void> => {
    const capture = captureClient(client);
    try {
      const mode = await ensureMode();

      if (mode === "dialstdio") {
        const upstream = await openDialStdioUpstream(pooledUnreliable);
        capture.feed(upstream);
        capture.commit(upstream);
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
        await downgradeToDialStdio(capture, safeErrorMessage(err));
        return;
      }

      capture.feed(channel);
      // overflow ⇒ a large upload is plainly being serviced → commit rather than
      // risk a truncated replay (see VERIFY_BUFFER_CAP_BYTES).
      const firstByte = capture.overflowed
        ? null
        : await awaitFirstByte(channel, STREAMLOCAL_DATA_VERIFY_TIMEOUT_MS);
      if (capture.overflowed || firstByte) {
        // Forward the proving byte straight to the client — the pipe below only
        // carries bytes that arrive AFTER it attaches — then hand off the rest.
        if (firstByte) client.write(firstByte);
        capture.commit(channel);
        return;
      }

      capture.stop(); // don't write late bytes to the channel we're about to tear down
      channel.destroy();
      await downgradeToDialStdio(capture, "channel opened but no data flowed");
    } catch (err) {
      console.warn(`[docker-ssh] bridge client failed (${opts.host ?? "?"}): ${safeErrorMessage(err)}`);
      capture.fail();
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
