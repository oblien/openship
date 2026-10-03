import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  HOST_CHANNEL_AUTH_REJECTED,
  HOST_CHANNEL_NOT_PROVISIONED,
  HOST_CHANNEL_ROW_CREDENTIALS_UNUSED,
  hostFirewallRule,
} from "@repo/core";

import type { SshConfig } from "../types";
import { systemDebug } from "./debug";

function formatSshTarget(config: SshConfig): string {
  const target = `${config.username ?? "root"}@${config.host}`;
  return config.sshTransport === "cloudflare" ? `${target} (Cloudflare Access)` : `${target}:${config.port ?? 22}`;
}

/**
 * Describe a REJECTED credential — the auth half, as opposed to
 * {@link describeSshConnectFailure}'s transport half.
 *
 * The `hostChannel` branch is this function's #490: that bug was operators auditing
 * `authorized_keys` over what was really a packet filter, and the fix was to stop
 * wording a connect failure like a credential one. #527 is the mirror image and went
 * unfixed for six releases — a rejected host-channel key worded as a stored-credential
 * problem ("check the username, private key, passphrase"), on a row whose stored
 * credentials nothing dials with. The reporter moved key files between /tmp, /root and
 * ~/.ssh for a dozen messages because this string told them to.
 */
export function describeSshAuthFailure(config: SshConfig, originalMessage: string): string {
  const target = formatSshTarget(config);

  // Checked before password/privateKey: the host channel always carries a privateKey, so
  // the generic key branch below would otherwise claim it first and win every time.
  if (config.hostChannel) {
    return (
      `${HOST_CHANNEL_AUTH_REJECTED} Dialed ${target} from inside the Openship API ` +
      `container. ${HOST_CHANNEL_ROW_CREDENTIALS_UNUSED} ${HOST_CHANNEL_NOT_PROVISIONED} ` +
      `(${originalMessage})`
    );
  }

  if (config.password) {
    return `SSH password authentication failed for ${target}. Check the username/password, or verify that the server allows password login. (${originalMessage})`;
  }

  if (config.privateKey || config.sshAgent) {
    return `SSH key authentication failed for ${target}. Check the username, private key, passphrase, or whether the server accepts this key. (${originalMessage})`;
  }

  return `SSH authentication failed for ${target}. (${originalMessage})`;
}

/**
 * Describe a failure to CONNECT — the TCP/handshake half, as opposed to
 * {@link describeSshAuthFailure}'s credential half.
 *
 * Worth its own message because the two are indistinguishable from the raw ssh2
 * error and lead to opposite remedies. A dropped SYN surfaces as a bare "Timed out
 * while waiting for handshake" with no host, no port and no cause, which reads
 * exactly like a rejected key — so operators go and audit `authorized_keys` while
 * the actual problem is a packet filter (#490).
 *
 * The original message is appended verbatim, and not only for detail:
 * `isRetryableRemoteConnectionError` matches on substrings like "Timed out" and
 * "ETIMEDOUT", so dropping it would silently reclassify every connect failure as
 * non-retryable.
 */
export function describeSshConnectFailure(config: SshConfig, originalMessage: string): string {
  const target = formatSshTarget(config);
  const port = config.port ?? 22;

  // The container→host bridge. A firewall is BY FAR the likeliest cause here: the
  // address is a host-local one, so the packet traverses the host's filter/INPUT
  // chain, where a default-deny ufw/firewalld policy drops it — unlike a published
  // container port, which is DNAT'd through nat/FORWARD and bypasses ufw entirely.
  //
  // `unknown` is the honest kind, not a fallback: we are inside the container, so we
  // cannot read the host's firewall and have to offer both syntaxes. Printing only the
  // ufw form — as this did — left every RHEL-family host with advice it can't run.
  if (config.hostChannel) {
    return (
      `Cannot reach the host SSH endpoint ${target} from inside the Openship API container. ` +
      `Host control is configured, but the connection never completed. The usual cause is a ` +
      `host firewall dropping traffic from the Docker bridge to the host's SSH port — allow ` +
      `it with:\n${hostFirewallRule("unknown", [], port)}\n` +
      `Or re-run \`openship up\`, which probes this and offers the exact rule. (${originalMessage})`
    );
  }

  if (config.sshTransport === "cloudflare") {
    return (
      `Cannot reach ${target} over SSH. Check the network connection and cloudflared sign-in on the machine running Openship, ` +
      `the Access policy, and the tunnel's SSH origin. (${originalMessage})`
    );
  }

  return (
    `Cannot reach ${target} over SSH. Check the network connection on the machine running Openship, ` +
    `then check that the host is up, that port ${port} is open, ` +
    `and that no firewall or security group is dropping the connection. (${originalMessage})`
  );
}

function execFileText(
  command: string,
  args: string[],
  timeout = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || stdout.trim() || err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseKnownHostsEntries(text: string): Set<string> {
  const entries = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      entries.add(`${parts[1]} ${parts[2]}`);
    }
  }

  return entries;
}

export async function reconcileKnownHosts(config: SshConfig): Promise<void> {
  const knownHostsPath = join(homedir(), ".ssh", "known_hosts");

  try {
    await access(knownHostsPath);
  } catch {
    return;
  }

  const port = config.port ?? 22;
  const hostPatterns = port === 22
    ? [config.host]
    : [config.host, `[${config.host}]:${port}`];

  const knownEntries = new Set<string>();
  for (const pattern of hostPatterns) {
    try {
      const output = await execFileText(
        "ssh-keygen",
        ["-F", pattern, "-f", knownHostsPath],
        4_000,
      );
      for (const entry of parseKnownHostsEntries(output)) {
        knownEntries.add(entry);
      }
    } catch {
      // No matching entry for this host pattern.
    }
  }

  if (knownEntries.size === 0) return;

  let scanned: string;
  try {
    scanned = await execFileText(
      "ssh-keyscan",
      ["-p", String(port), "-T", "5", config.host],
      7_000,
    );
  } catch {
    return;
  }

  const scannedEntries = parseKnownHostsEntries(scanned);
  if (scannedEntries.size === 0) return;

  for (const entry of knownEntries) {
    if (scannedEntries.has(entry)) {
      return;
    }
  }

  for (const pattern of hostPatterns) {
    try {
      await execFileText(
        "ssh-keygen",
        ["-R", pattern, "-f", knownHostsPath],
        4_000,
      );
      systemDebug(
        "ssh-known-hosts",
        `removed stale known_hosts entry for ${pattern}`,
      );
    } catch {
      // Best effort cleanup only.
    }
  }
}

/**
 * Resolve the SSH agent socket for "agent" auth.
 *
 * The orchestrator is often a GUI-launched desktop app that never inherited the
 * user's `SSH_AUTH_SOCK` from a login shell — so plain `process.env` is empty
 * even though `ssh` works fine in the user's terminal. When the env var is
 * unset, ask the OS for the per-user agent socket: on macOS `launchctl getenv
 * SSH_AUTH_SOCK` returns it even for GUI processes (the same trick VS Code uses).
 * Returns null when no agent can be found.
 */
export async function resolveSshAuthSock(): Promise<string | null> {
  // 1. Inherited env — covers shell- and service-launched processes on every
  //    platform (the common case for the dev server and self-hosted installs).
  const fromEnv = process.env.SSH_AUTH_SOCK;
  if (fromEnv) return fromEnv;

  // 2. GUI-launched apps (the desktop shell) often don't inherit it. Ask the
  //    OS session manager for the per-user value.
  if (process.platform === "darwin") {
    // macOS: the value lives in the launchd user session.
    try {
      const stdout = await execFileText("launchctl", ["getenv", "SSH_AUTH_SOCK"], 4_000);
      const sock = stdout.trim();
      if (sock) return sock;
    } catch {
      // launchctl missing / no value — fall through.
    }
  } else if (process.platform === "linux") {
    // Linux desktops that run an ssh-agent under the systemd user manager
    // (gnome-keyring, the ssh-agent.service unit) export it there.
    try {
      const stdout = await execFileText("systemctl", ["--user", "show-environment"], 4_000);
      const line = stdout.split("\n").find((l) => l.startsWith("SSH_AUTH_SOCK="));
      const sock = line?.slice("SSH_AUTH_SOCK=".length).trim();
      if (sock) return sock;
    } catch {
      // systemctl missing (non-systemd) / no value — fall through.
    }
  }
  // Windows OpenSSH resolves its agent named pipe and user configuration itself.
  return null;
}
