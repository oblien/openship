import http from "node:http";
import type { Duplex } from "node:stream";

import type { ClientChannel } from "ssh2";

import {
  connectSshClient,
  execSshCommand,
  openSshUnixSocket,
  type StreamLocalCapableClient,
} from "../system/ssh-client";
import type { SshConfig } from "../types";
import type { DockerConnectionOptions } from "./docker-transport";

const DEFAULT_REMOTE_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const resolvedDockerSocketPathCache = new WeakMap<DockerConnectionOptions, Promise<string>>();

type SshSocket = ClientChannel & {
  setTimeout?: (msecs: number, callback?: () => void) => SshSocket;
  setNoDelay?: (noDelay?: boolean) => SshSocket;
  setKeepAlive?: (enable?: boolean, initialDelay?: number) => SshSocket;
  ref?: () => SshSocket;
  unref?: () => SshSocket;
  destroySoon?: () => void;
};

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

async function discoverRemoteDockerSocketPathsWithClient(
  client: StreamLocalCapableClient,
): Promise<string[]> {
  const command = [
    "set -eu",
    'uid="$(id -u 2>/dev/null || printf 0)"',
    'printf "%s\\n" "/var/run/docker.sock" "/run/docker.sock" "/run/podman/podman.sock" "/run/user/$uid/docker.sock" "$HOME/.docker/run/docker.sock" | while IFS= read -r candidate; do if [ -S "$candidate" ]; then printf "%s\\n" "$candidate"; fi; done',
    'find /run/user -maxdepth 2 -type s \( -name docker.sock -o -name podman.sock \) -print 2>/dev/null || true',
    'for dir in /run /var/run "$HOME/.docker/run"; do',
    '  if [ -d "$dir" ]; then',
    '    find "$dir" -maxdepth 3 -type s \\( -name docker.sock -o -name podman.sock \\) -print 2>/dev/null || true',
    "  fi",
    "done",
  ].join("\n");

  const result = await execSshCommand(client, command);
  const lines = [result.stdout, result.stderr]
    .filter(Boolean)
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);

  return normalizeSocketPathLines(lines);
}

async function discoverRemoteDockerSocketPaths(
  opts: DockerConnectionOptions,
): Promise<string[]> {
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
  const message = error instanceof Error ? error.message : String(error);
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
      `remote diagnostic failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  } finally {
    conn?.end();
  }
}

function patchSocket(channel: SshSocket): SshSocket {
  if (!channel.setTimeout) {
    channel.setTimeout = (_msecs: number, callback?: () => void) => {
      if (callback) channel.once("timeout", callback);
      return channel;
    };
  }
  if (!channel.setNoDelay) {
    channel.setNoDelay = () => channel;
  }
  if (!channel.setKeepAlive) {
    channel.setKeepAlive = () => channel;
  }
  if (!channel.ref) {
    channel.ref = () => channel;
  }
  if (!channel.unref) {
    channel.unref = () => channel;
  }
  if (!channel.destroySoon) {
    channel.destroySoon = () => {
      channel.end();
      channel.destroy();
    };
  }

  return channel;
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
            `SSH session established, but opening a streamlocal channel to ${socketPath} failed: ${error instanceof Error ? error.message : String(error)}`,
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

  try {
    await probeDockerSshBridge(opts);
  } catch (error) {
    const diagnostics = shouldCollectSocketDiagnostics(error)
      ? formatSocketDiagnostics(await collectDockerSocketDiagnostics(opts, socketPath))
      : "";

    throw new Error(
      `Cannot reach Docker daemon: ${error instanceof Error ? error.message : String(error)}. ` +
        `Preflight steps: SSH login -> resolve remote Docker socket path -> open streamlocal tunnel -> Docker API ping. ` +
        `Current failure: streamlocal tunnel could not be opened for ${socketPath}. ` +
        "Check that the remote Docker-compatible socket exists, the SSH server allows streamlocal forwarding, and the SSH user can access that socket." +
        diagnostics,
    );
  }
}

export function createDockerSshAgent(opts: DockerConnectionOptions): http.Agent {
  const agent = new http.Agent({ keepAlive: false });

  agent.createConnection = (
    _options: http.ClientRequestArgs,
    callback?: (error: Error | null, socket: Duplex) => void,
  ) => {
    let conn: StreamLocalCapableClient | null = null;
    let reported = false;
    let channelClosed = false;

    const fail = (error: Error) => {
      if (reported) return;
      reported = true;
      conn?.end();
      callback?.(error, undefined as unknown as Duplex);
    };

    resolveRemoteDockerSocketPath(opts)
      .then((socketPath) => connectSshClient(toSshConfig(opts)).then((client) => ({ client, socketPath })))
      .then(async ({ client, socketPath }) => {
        conn = client;
        client.once("end", () => {
          if (!reported && !channelClosed) {
            fail(new Error("SSH connection ended before the Docker socket tunnel was established."));
          }
        });

        const stream = await openSshUnixSocket(client, socketPath);
        const socket = patchSocket(stream as SshSocket);

        socket.on("error", () => {
          client.end();
        });
        socket.once("close", () => {
          channelClosed = true;
          client.end();
        });

        reported = true;
        callback?.(null, socket);
      })
      .catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });

    return undefined;
  };

  return agent;
}
