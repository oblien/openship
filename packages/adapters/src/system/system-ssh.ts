import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, win32 as win32Path } from "node:path";

import type { SshConfig } from "../types";
import { shellSplitWords } from "@repo/core";

/**
 * Shared "agent case" logic for the system-`ssh` path.
 *
 * When SSH auth is "agent", openship shells out to the OS `ssh` binary instead
 * of the in-process `ssh2` client (only the real OpenSSH client reliably
 * resolves the agent / `~/.ssh/config` / default keys / macOS keychain — the
 * same thing that makes `ssh root@host` work in a terminal). Every system-`ssh`
 * invocation — command exec, file ops, port-forward, Docker socket-forward, the
 * interactive shell — shares the argv and env produced here. POSIX hosts reuse
 * one authenticated ControlMaster connection; Windows uses direct OpenSSH
 * connections because its control-socket path is not reliable.
 */

/** Default connect timeout (seconds) handed to `ssh -o ConnectTimeout`. */
const CONNECT_TIMEOUT_SECONDS = 15;

/**
 * Allocate a short, unique ControlMaster socket path.
 *
 * Kept short because the control socket is a Unix domain socket, whose path is
 * capped at ~104 bytes by the OS. POSIX hosts use `/tmp`; Windows still gets a
 * native temp path for compatibility with callers, but does not pass it to
 * OpenSSH because Windows control sockets are unreliable.
 */
export function makeControlPath(): string {
  const name = `openship-ssh-${process.pid}-${randomBytes(6).toString("hex")}.sock`;
  return process.platform === "win32" ? join(tmpdir(), name) : `/tmp/${name}`;
}

/**
 * Common `ssh` arguments shared by the master connection and every client
 * invocation that reuses it. Includes the ControlMaster multiplexing options,
 * the port, non-interactive/host-key conventions (mirrors
 * `buildRsyncSshCommand` in remote-transfer.ts), the optional jump host, and
 * any extra raw args configured on the server.
 *
 * Does NOT include the target (`user@host`) or a remote command — callers
 * append those.
 */
export function supportsSshControlMaster(platform = process.platform): boolean {
  return platform !== "win32";
}

export function buildBaseSshArgs(
  config: SshConfig,
  controlPath: string,
  identityFile?: string,
  platform = process.platform,
): string[] {
  const args: string[] = [
    "-p", String(config.port ?? 22),
    // Password-authenticated ProxyCommand connections use SSH_ASKPASS (set by
    // sshChildEnv) because the API has no interactive stdin. BatchMode would
    // disable that path entirely; key/agent connections remain fully
    // non-interactive.
    ...(config.password
      ? [
          "-o", "BatchMode=no",
          "-o", "PreferredAuthentications=password,keyboard-interactive",
          "-o", "PubkeyAuthentication=no",
        ]
      : ["-o", "BatchMode=yes"]),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];

  // Unix OpenSSH uses a Unix-domain control socket for multiplexing. The
  // Windows OpenSSH client is not reliable with this path and can fail with
  // `getsockname failed: Not a socket`; direct connections still preserve all
  // ProxyCommand behavior and are safer for the desktop build.
  if (supportsSshControlMaster(platform)) {
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlPath}`,
      "-o", "ControlPersist=300",
    );
  }

  if (identityFile) {
    args.push("-i", identityFile, "-o", "IdentitiesOnly=yes");
  }

  if (config.sshJumpHost?.trim()) {
    args.push("-J", config.sshJumpHost.trim());
  }

  // ProxyCommand must remain one argv value. In particular, Cloudflare's Windows
  // command commonly contains a quoted path with spaces:
  // `"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" access ssh --hostname %h`.
  // Passing `-o` and the full value separately avoids the shell splitting the path.
  if (config.sshProxyCommand?.trim()) {
    args.push("-o", `ProxyCommand=${config.sshProxyCommand.trim()}`);
  }

  // Extra raw args are a freeform string (e.g. `-o IPQoS=throughput`). Use the
  // shared quote-aware splitter so existing quoted options keep working too.
  if (config.sshArgs?.trim()) {
    args.push(...shellSplitWords(config.sshArgs));
  }

  return args;
}

/** The `user@host` target for the ssh invocation. */
export function sshTarget(config: SshConfig): string {
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
export function sshChildEnv(
  config: SshConfig,
  platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (config.sshAgent) {
    env.SSH_AUTH_SOCK = config.sshAgent;
  }
  if (config.password && config.sshAskpassPath) {
    env.SSH_ASKPASS = config.sshAskpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.OPENSHIP_SSH_ASKPASS_PASSWORD = config.password;
    if (config.sshAskpassNodePath) {
      env.OPENSHIP_SSH_ASKPASS_NODE = config.sshAskpassNodePath;
    }
  }

  // The packaged Windows desktop ships cloudflared beside the app. Prepending
  // its directory lets the portable preset use `cloudflared access ssh ...`
  // while preserving explicit ProxyCommand paths and developer environments.
  const bundledCloudflared = env.OPENSHIP_CLOUDFLARED_PATH;
  if (platform === "win32" && bundledCloudflared) {
    const cloudflaredDir = platform === "win32"
      ? win32Path.dirname(bundledCloudflared)
      : dirname(bundledCloudflared);
    env.PATH = `${cloudflaredDir};${env.PATH ?? ""}`;
  }
  return env;
}
