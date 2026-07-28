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

  const openDialStdioUpstream = async (): Promise<Duplex> => {
    // Pooled executor path: same connection + env/PATH as the working build.
    if (opts.executor?.openDockerDialStdio) {
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

  const openUpstream = async (): Promise<Duplex> => {
    const mode = await ensureMode();
    return mode === "dialstdio" ? openDialStdioUpstream() : openStreamlocalUpstream(opts);
  };

  const server = net.createServer((client) => {
    clients.add(client);
    client.setNoDelay(true);
    client.once("close", () => clients.delete(client));

    openUpstream()
      .then((upstream) => {
        const teardown = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on("error", teardown);
        upstream.on("error", teardown);
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
        // Bidirectional pipe: propagates backpressure and end/close between
        // dockerode's HTTP socket and the SSH upstream (streamlocal or dial-stdio).
        client.pipe(upstream);
        upstream.pipe(client);
      })
      .catch((error) => {
        console.warn(`[docker-ssh] bridge upstream open failed: ${safeErrorMessage(error)}`);
        client.destroy(error instanceof Error ? error : new Error(String(error)));
      });
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
