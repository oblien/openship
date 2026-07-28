import Dockerode from "dockerode";
import type { CommandExecutor } from "../types";

import { createDockerSshBridge, type DockerSshBridge } from "./docker-ssh-agent";

export interface DockerConnectionOptions {
  /** Transport type */
  transport?: "socket" | "ssh" | "tcp";

  /**
   * Pooled command executor for SSH transport.  When provided, Docker
   * API calls reuse the executor's SSH connection (via streamlocal
   * channel multiplexing) instead of creating a fresh SSH connection
   * per HTTP request.
   */
  executor?: CommandExecutor;

  /** Explicit Docker socket path on the remote host (SSH transport only) */
  dockerSocketPath?: string;

  /** Host for SSH / TCP transports */
  host?: string;
  /** Port (SSH default 22, TCP default 2376) */
  port?: number;

  /** SSH username */
  username?: string;
  /** SSH password (for servers configured with password auth) */
  password?: string;
  /** Decrypted SSH private key (PEM string). */
  privateKey?: string;
  /** Passphrase for the SSH private key (if the key itself is encrypted) */
  privateKeyPassphrase?: string;
  /** SSH agent socket path (alternative to privateKey) */
  sshAgent?: string;
  /** Custom host key verifier for SSH connections. */
  hostVerifier?: (hostKey: Buffer) => boolean;

  /** TLS CA certificate (for TCP transport) */
  ca?: string | Buffer;
  /** TLS client certificate (for TCP transport) */
  cert?: string | Buffer;
  /** TLS client key (for TCP transport) */
  key?: string | Buffer;

  /** Docker API request timeout in ms */
  timeout?: number;
}

export interface DockerTransport {
  kind: "socket" | "ssh" | "tcp";
  description: string;
  unreachableHint: string;
  /** Resolve dockerode options, standing up any transport machinery (e.g. the SSH bridge). */
  establish: () => Promise<Dockerode.DockerOptions>;
  /** Tear down machinery created by establish(). Idempotent; safe to call when never established. */
  close: () => Promise<void>;
  preflight: () => Promise<void>;
}

export function resolveDockerTransport(opts?: DockerConnectionOptions): DockerTransport {
  if (!opts || !opts.transport || opts.transport === "socket") {
    return {
      kind: "socket",
      description: "local Docker daemon via socket",
      unreachableHint: "Check that the local Docker daemon is running.",
      establish: async () => ({ socketPath: "/var/run/docker.sock" }),
      close: async () => {},
      preflight: async () => {},
    };
  }

  if (opts.transport === "ssh") {
    if (!opts.privateKey && !opts.sshAgent && !opts.password) {
      throw new Error("SSH transport requires one of privateKey, sshAgent, or password.");
    }

    let bridge: DockerSshBridge | null = null;

    return {
      kind: "ssh",
      description: `remote Docker daemon via SSH (${opts.host ?? "unknown-host"})`,
      unreachableHint:
        "Check that SSH credentials are correct, Docker is running on the server, and the SSH user can access the Docker daemon (in the `docker` group or root). The transport uses SSH socket forwarding where available and falls back to `docker system dial-stdio` over an exec channel otherwise.",
      establish: async () => {
        bridge = createDockerSshBridge(opts);
        const { host, port } = await bridge.start();
        return {
          protocol: "http",
          host,
          port,
          timeout: opts.timeout ?? 600_000,
        };
      },
      close: async () => {
        bridge?.close();
        bridge = null;
      },
      // Decide the upstream transport (streamlocal vs dial-stdio) up front so
      // the daemon `ping()` in assertReachable runs over the working one. The
      // ping itself is the real reachability check.
      preflight: async () => {
        await bridge?.probe();
      },
    };
  }

  if (!opts.ca || !opts.cert || !opts.key) {
    throw new Error(
      "TCP transport requires ca, cert, and key for mutual TLS. Plaintext TCP connections are not supported for security reasons.",
    );
  }

  return {
    kind: "tcp",
    description: `remote Docker daemon via TLS (${opts.host ?? "unknown-host"}:${opts.port ?? 2376})`,
    unreachableHint: "Check that the remote Docker daemon is reachable and the TLS certificates are valid.",
    establish: async () => ({
      protocol: "https",
      host: opts.host,
      port: opts.port ?? 2376,
      ca: opts.ca as string | undefined,
      cert: opts.cert as string | undefined,
      key: opts.key as string | undefined,
      timeout: opts.timeout ?? 30_000,
    }),
    close: async () => {},
    preflight: async () => {},
  };
}