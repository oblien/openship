import { randomBytes } from "node:crypto";
import { assertSshDestination, parseSshTuningArgs } from "@repo/core";

import type { SshConfig } from "../types";
import { buildCloudflareProxyCommand } from "./cloudflare-ssh";

export function supportsSshMultiplexing(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** Shared by system SSH and rsync so no transfer can bypass the saved transport. */
export function buildSshTransportArgs(config: SshConfig, platform: NodeJS.Platform = process.platform): string[] {
  assertSshDestination(config);
  const args: string[] = [];
  if (config.sshJumpHost?.trim()) args.push("-J", config.sshJumpHost.trim());
  if (config.sshTransport === "cloudflare") args.push("-o", `ProxyCommand=${buildCloudflareProxyCommand(config.host, { platform })}`);
  args.push(...parseSshTuningArgs(config.sshArgs));
  return args;
}

/**
 * Shared "agent case" logic for the system-`ssh` path.
 *
 * When SSH auth is "agent", openship shells out to the OS `ssh` binary instead
 * of the in-process `ssh2` client (only the real OpenSSH client reliably
 * resolves the agent / `~/.ssh/config` / default keys / macOS keychain — the
 * same thing that makes `ssh root@host` work in a terminal). Every system-`ssh`
 * invocation — command exec, file ops, port-forward, Docker socket-forward, the
 * interactive shell — shares the argv and env produced here. Unix clients reuse
 * an authenticated ControlMaster; Windows uses foreground connections.
 */

/** Default connect timeout (seconds) handed to `ssh -o ConnectTimeout`. */
const CONNECT_TIMEOUT_SECONDS = 15;

/**
 * Allocate a short, unique ControlMaster socket path.
 *
 * Kept under `/tmp` (and short) because the control socket is a Unix domain
 * socket, whose path is capped at ~104 bytes by the OS. macOS's per-user
 * tmpdir is long enough to blow that budget, so we use `/tmp` directly — it
 * exists on every macOS/Linux host (the platforms this path supports).
 */
export function makeControlPath(): string {
  return `/tmp/openship-ssh-${process.pid}-${randomBytes(6).toString("hex")}.sock`;
}

/**
 * Common `ssh` arguments shared by the master connection and every client
 * invocation that reuses it. Includes the ControlMaster multiplexing options,
 * the port, non-interactive/host-key conventions (mirrors
 * `buildRsyncSshCommand` in remote-transfer.ts), the optional jump host, and
 * the selected transport and allowlisted connection tuning options.
 *
 * Does NOT include the target (`user@host`) or a remote command — callers
 * append those.
 */
export function buildBaseSshArgs(config: SshConfig, controlPath: string, platform: NodeJS.Platform = process.platform): string[] {
  assertSshDestination(config);
  const args: string[] = [
    "-p", String(config.port ?? 22),
    // BatchMode keeps the OS ssh non-interactive: agent/keys only, never a
    // password/passphrase prompt that would hang a headless API process.
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];

  if (supportsSshMultiplexing(platform)) {
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=300");
  } else {
    args.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
  }

  args.push(...buildSshTransportArgs(config, platform));

  return args;
}

/** The `user@host` target for the ssh invocation. */
export function sshTarget(config: SshConfig): string {
  assertSshDestination(config);
  return `${config.username ?? "root"}@${config.host}`;
}

/**
 * Environment for the `ssh` child process.
 *
 * Critically injects `SSH_AUTH_SOCK` from the resolved agent socket: a
 * GUI-launched API process (desktop app) often has no `SSH_AUTH_SOCK` in its
 * own env, but `resolveSshAuthSock()` recovers it (env → macOS `launchctl`)
 * and stores it on `config.sshAgent`. Without this the spawned `ssh` would not
 * see the agent and would fail exactly like the old `ssh2` path.
 */
export function sshChildEnv(config: SshConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.sshAgent) {
    env.SSH_AUTH_SOCK = config.sshAgent;
  }
  return env;
}
