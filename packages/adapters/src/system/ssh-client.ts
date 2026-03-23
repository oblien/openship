import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";

import type { SshConfig } from "../types";
import { isSshAuthError } from "./errors";
import { describeSshAuthFailure, reconcileKnownHosts } from "./ssh-support";

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
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
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
      reject(err);
    });

    client.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("SSH connection closed before ready"));
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

export async function execSshCommand(
  client: Client,
  command: string,
  timeout = 10_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      reject(new Error(`SSH command timed out after ${timeout}ms: ${command}`));
    }, timeout);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
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