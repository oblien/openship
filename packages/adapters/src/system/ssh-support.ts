import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { hostFirewallRule } from "@repo/core";

import type { SshConfig } from "../types";
import { systemDebug } from "./debug";

function formatSshTarget(config: SshConfig): string {
  return `${config.username ?? "root"}@${config.host}:${config.port ?? 22}`;
}

export function describeSshAuthFailure(config: SshConfig, originalMessage: string): string {
  const target = formatSshTarget(config);

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

  return (
    `Cannot reach ${target} over SSH. Check that the host is up, that port ${port} is open, ` +
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