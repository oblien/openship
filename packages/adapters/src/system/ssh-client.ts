import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import type { Duplex, Readable } from "node:stream";

import { safeErrorMessage } from "@repo/core";

import type { SshConfig } from "../types";
import { isSshAuthError } from "./errors";
import {
  describeSshAuthFailure,
  describeSshConnectFailure,
  reconcileKnownHosts,
} from "./ssh-support";

export type StreamLocalCapableClient = Client & {
  openssh_forwardOutStreamLocal?: (
    socketPath: string,
    callback: (err: Error | undefined, stream: ClientChannel) => void,
  ) => void;
};

function toHostVerifier(config: SshConfig): ConnectConfig["hostVerifier"] {
  if (!config.hostVerifier) {
    return undefined;
  }

  return (key: Buffer | string) => config.hostVerifier!(Buffer.isBuffer(key) ? key : Buffer.from(key));
}

function toConnectConfig(config: SshConfig): ConnectConfig {
  return {
    host: config.host,
    port: config.port ?? 22,
    username: config.username ?? "root",
    hostVerifier: toHostVerifier(config),
    password: config.password,
    privateKey: config.privateKey,
    passphrase: config.privateKeyPassphrase,
    agent: config.sshAgent,
    tryKeyboard: false,
    // Explicit rather than relying on ssh2's implicit 20s so callers can shorten it.
    // The container→host channel does (8s): a filtered SYN there would otherwise
    // stall every host operation for 20s apiece with no output.
    readyTimeout: config.readyTimeoutMs ?? 20_000,
    keepaliveInterval: 15_000,
    // 10 (~150s) rather than 3 (45s): a small server pegged by a heavy
    // `docker build` / `bun install` can briefly starve sshd of keepalive
    // replies, and 45s was dropping the SSH channel mid-build (build failed with
    // a bare "exited with code 1"). Still detects a truly-dead link within ~2.5m.
    keepaliveCountMax: 10,
  };
}

export async function connectSshClient(config: SshConfig): Promise<StreamLocalCapableClient> {
  await reconcileKnownHosts(config);

  const client = new Client() as StreamLocalCapableClient;

  return new Promise<StreamLocalCapableClient>((resolve, reject) => {
    let settled = false;

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });

    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (isSshAuthError(err)) {
        reject(new Error(describeSshAuthFailure(config, err.message)));
        return;
      }
      reject(new Error(describeSshConnectFailure(config, err.message)));
    });

    client.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error(describeSshConnectFailure(config, "SSH connection closed before ready")));
    });

    client.connect(toConnectConfig(config));
  });
}

export async function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

export async function openSshUnixSocket(
  client: StreamLocalCapableClient,
  socketPath: string,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    if (!client.openssh_forwardOutStreamLocal) {
      reject(new Error("SSH server/client does not support OpenSSH streamlocal socket forwarding."));
      return;
    }

    client.openssh_forwardOutStreamLocal(socketPath, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * The Docker Engine API carried over a plain SSH exec channel (no streamlocal).
 *
 * One copy, in the layer both callers already import: the bridge's ephemeral dial-stdio
 * client and `SshExecutor.openDockerDialStdio` must open the *same* command, or the
 * transport the bridge probes is not the transport it falls back to.
 */
export const DOCKER_DIAL_STDIO_COMMAND = "docker system dial-stdio";

/**
 * Open a raw exec channel for `command` and return the ssh2 ClientChannel
 * (a Duplex: writes → remote stdin, reads ← remote stdout). No PTY is
 * requested, so the byte stream is clean — used to carry
 * `docker system dial-stdio`, which proxies the Docker daemon socket over an
 * exec channel (the same transport `DOCKER_HOST=ssh://` uses). Unlike
 * streamlocal forwarding, exec channels work on every sshd (no
 * `AllowStreamLocalForwarding`) and under the Bun-compiled desktop runtime.
 */
export async function openSshExecChannel(
  client: Client,
  command: string,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Why a dial-stdio channel died, kept ON the channel.
 *
 * When this transport fails it fails in words: `Cannot connect to the Docker daemon at
 * unix:///var/run/docker.sock` (dockerd not running — the Amazon Linux case), `permission
 * denied while trying to connect to the Docker daemon socket`, `docker: command not found`,
 * or an sshd ForceCommand's own banner (`Please login as the user "ec2-user"…`, exit 142).
 * Every one of those went to `console.warn` in a server log nobody reads, while the caller
 * got a destroyed socket and dockerode turned it into `socket hang up`.
 *
 * Buffering them onto the stream is what lets the bridge answer the request with the real
 * cause instead of a reset — the reader is `dialStdioDiagnostics`, and it needs no
 * plumbing through the three layers between here and there.
 */
const DIAL_STDIO_DIAGNOSTICS = Symbol("openship.dialStdioDiagnostics");

/** First 4 KiB only: the cause is the first line, the rest is a daemon log tail. */
const DIAL_STDIO_STDERR_CAP = 4096;

interface DialStdioDiagnostics {
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

type DiagnosedChannel = Duplex & { [DIAL_STDIO_DIAGNOSTICS]?: DialStdioDiagnostics };

/**
 * Record why `stream` (a dial-stdio channel) fails, and give it its permanent error floor.
 *
 * The floor is not incidental. Between the moment this channel is opened and the moment the
 * bridge pipes it, nothing else listens for `error`; an ssh2 channel error in that window
 * would be an unhandled `error` event and would take the whole API process down over one
 * dead Docker request. This listener is never removed, so that gap does not exist.
 *
 * Idempotent — the pooled executor already attaches it, and the bridge attaches it again
 * without knowing that.
 */
export function attachDialStdioDiagnostics<T extends Duplex>(stream: T): T {
  const channel = stream as T & DiagnosedChannel;
  if (channel[DIAL_STDIO_DIAGNOSTICS]) return stream;

  const diagnostics: DialStdioDiagnostics = {
    stderr: "",
    exitCode: null,
    signal: null,
    error: null,
  };
  channel[DIAL_STDIO_DIAGNOSTICS] = diagnostics;

  const stderr = (stream as unknown as { stderr?: Readable }).stderr;
  stderr?.on("data", (chunk: Buffer) => {
    if (diagnostics.stderr.length >= DIAL_STDIO_STDERR_CAP) return;
    diagnostics.stderr = (diagnostics.stderr + chunk.toString("utf8")).slice(
      0,
      DIAL_STDIO_STDERR_CAP,
    );
  });
  stream.on("exit", (code: unknown, signal: unknown) => {
    diagnostics.exitCode = typeof code === "number" ? code : null;
    diagnostics.signal = typeof signal === "string" ? signal : null;
  });
  stream.on("error", (err: unknown) => {
    diagnostics.error ??= safeErrorMessage(err);
  });

  return stream;
}

/**
 * One operator-facing sentence about why a dial-stdio channel failed, or `""` when it never
 * said anything (a stream with no diagnostics attached also reads as `""` — the caller then
 * describes the close itself rather than inventing a cause).
 */
export function dialStdioDiagnostics(stream: Duplex | null | undefined): string {
  const diagnostics = (stream as DiagnosedChannel | null | undefined)?.[DIAL_STDIO_DIAGNOSTICS];
  if (!diagnostics) return "";

  const parts: string[] = [];
  const stderr = diagnostics.stderr.trim();
  if (stderr) parts.push(stderr.replace(/\s+/g, " "));
  if (diagnostics.error) parts.push(diagnostics.error);
  if (diagnostics.signal) parts.push(`killed by ${diagnostics.signal}`);
  else if (diagnostics.exitCode) parts.push(`exit code ${diagnostics.exitCode}`);
  if (parts.length === 0) return "";

  return `\`${DOCKER_DIAL_STDIO_COMMAND}\` reported: ${parts.join(" — ")}`;
}

/**
 * Open a diagnostics-carrying `docker system dial-stdio` channel.
 *
 * The single entry point for this transport: `SshExecutor.openDockerDialStdio` (pooled
 * connection) and the bridge's ephemeral client both go through here, so the command, the
 * diagnostics and the error floor cannot drift apart between the transport the bridge
 * probes and the one it falls back to.
 */
export async function openDockerDialStdioChannel(client: Client): Promise<Duplex> {
  return attachDialStdioDiagnostics(await openSshExecChannel(client, DOCKER_DIAL_STDIO_COMMAND));
}

export async function execSshCommand(
  client: Client,
  command: string,
  timeout = 10_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stream: ClientChannel | undefined;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (stream) {
        try {
          stream.close();
        } catch {
          /* already closed */
        }
      }
      reject(new Error(`SSH command timed out after ${timeout}ms: ${command}`));
    }, timeout);

    client.exec(command, (err, execStream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      stream = execStream;

      if (timedOut) {
        // Timer already fired (exec itself was slow to hand back the
        // channel) - tear this one down too instead of leaving it orphaned.
        try {
          stream.close();
        } catch {
          /* already closed */
        }
        return;
      }

      stream.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      stream.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      stream.on("close", (code?: number) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
      });
    });
  });
}