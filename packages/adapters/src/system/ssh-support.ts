import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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