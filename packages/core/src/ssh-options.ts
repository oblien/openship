import { shellSplitWords } from "./shell-split";

export type SshTransport = "direct" | "cloudflare";

/** A transport is a capability, never a caller-supplied command to run locally. */
export function normalizeSshTransport(value: unknown): SshTransport {
  if (value == null || value === "direct") return "direct";
  if (value === "cloudflare") return "cloudflare";
  throw new Error("Unsupported SSH transport. Choose direct SSH or Cloudflare Access.");
}

export function cloudflareSshUrl(host: string): string {
  // Cloudflare Access needs a public application hostname, not a URL, an IP,
  // or OpenSSH substitutions. The same validation protects both ssh clients.
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
    throw new Error("Cloudflare Access requires an application hostname, such as ssh.example.com.");
  }
  return `https://${host.toLowerCase()}/`;
}

// OpenSSH options are not just connection settings: several execute local
// commands, read/write files, or bypass our managed transport. Accept only
// tuning options, including for settings saved by older releases.
const TUNING_OPTIONS = new Set([
  "addressfamily", "ciphers", "compression", "connectionattempts",
  "connecttimeout", "hostkeyalgorithms", "ipqos", "kexalgorithms", "loglevel",
  "macs", "pubkeyacceptedalgorithms", "pubkeyacceptedkeytypes", "rekeylimit",
  "serveralivecountmax", "serveraliveinterval", "tcpkeepalive",
]);
const SIMPLE_FLAGS = new Set(["-4", "-6", "-C", "-q", "-v", "-vv", "-vvv", "-T"]);

export function parseSshTuningArgs(value?: string | null): string[] {
  if (!value?.trim()) return [];
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("SSH options must contain only connection tuning arguments.");
  }
  const words = shellSplitWords(value);
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (SIMPLE_FLAGS.has(word)) {
      args.push(word);
      continue;
    }
    const option = word === "-o" ? words[++i] : word.startsWith("-o") ? word.slice(2) : undefined;
    const match = option?.match(/^([a-z][a-z0-9]*)(?:=| +)([-+^a-z0-9_@.,:/]+)$/i);
    if (!match || !TUNING_OPTIONS.has(match[1]!.toLowerCase())) {
      throw new Error("Unsupported SSH option. Use connection tuning options and the dedicated jump host field.");
    }
    args.push("-o", `${match[1]}=${match[2]}`);
  }
  return args;
}

export function assertSshDestination(config: {
  host: string;
  username?: string;
  port?: number;
  sshJumpHost?: string;
  sshTransport?: string | null;
}): void {
  const transport = normalizeSshTransport(config.sshTransport);
  if (transport === "cloudflare") {
    cloudflareSshUrl(config.host);
    if (config.sshJumpHost?.trim()) {
      throw new Error("Choose either Cloudflare Access or a jump host for this SSH connection.");
    }
  }
  // Besides argv safety, reject characters expanded by ProxyJump/config
  // substitutions in system OpenSSH. Configuration on disk is operator-owned.
  const host = /^(?!-)[a-z0-9_[\].:%-]+$/i;
  const user = /^[a-z0-9_][a-z0-9_.-]*$/i;
  if (!host.test(config.host) || (config.username !== undefined && !user.test(config.username)) ||
      (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535))) {
    throw new Error("Invalid SSH host, username or port.");
  }
  if (config.sshJumpHost) {
    for (const jump of config.sshJumpHost.trim().split(",")) {
      const parts = jump.split("@");
      if (parts.length > 2 || (parts.length === 2 && !user.test(parts[0]!)) || !host.test(parts.at(-1)!)) {
        throw new Error("Invalid SSH jump host. Use [user@]host[:port].");
      }
    }
  }
}

/** Validate persisted/request settings before writes as well as at the SSH sink. */
export function assertSshSettings(settings: {
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshJumpHost?: string | null;
  sshArgs?: string | null;
  sshTransport?: string | null;
}): void {
  assertSshDestination({
    host: settings.sshHost?.trim() ?? "",
    username: settings.sshUser?.trim() || "root",
    port: settings.sshPort ?? 22,
    sshJumpHost: settings.sshJumpHost?.trim() || undefined,
    sshTransport: settings.sshTransport,
  });
  parseSshTuningArgs(settings.sshArgs);
}
