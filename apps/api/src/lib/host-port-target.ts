import { createHash, randomUUID } from "node:crypto";

import type { CommandExecutor } from "@repo/adapters";
import type { HostPortTargetKey } from "@repo/db";

/**
 * One physical TCP bind namespace.
 *
 * `targetKey` is the authority for new claims and locks. `legacyTargetKeys`
 * remain read-only aliases while claims backfilled by older migrations still
 * use a mutable server-row id.
 */
export interface HostPortTargetIdentity {
  targetKey: HostPortTargetKey;
  legacyTargetKeys: HostPortTargetKey[];
  /** False only for the credential-free SSH-locator fallback. */
  stable: boolean;
}

export interface HostPortConnectionLocator {
  sshHost: string;
  sshPort?: number | null;
  sshJumpHost?: string | null;
  sshArgs?: string | null;
}

const MACHINE_ID_PATH = "/etc/machine-id";
const OPENSHIP_HOST_ID_PATH = "/var/lib/openship/host-id";
const MACHINE_ID_RE = /^[0-9a-f]{32}$/i;
const HOST_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const stableTargetIds = new WeakMap<
  CommandExecutor,
  { source: "machine-id" | "openship-host-id"; value: string }
>();

function nonZeroHex(value: string): boolean {
  return /[1-9a-f]/i.test(value.replaceAll("-", ""));
}

export function normalizeTargetMachineId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return MACHINE_ID_RE.test(normalized) && nonZeroHex(normalized) ? normalized : null;
}

export function normalizeTargetHostId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return HOST_ID_RE.test(normalized) && nonZeroHex(normalized) ? normalized : null;
}

function normalizeSshHost(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  // A trailing root-label dot changes no DNS endpoint.
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

/** Deterministic, credential-free fallback when the target cannot expose an id. */
export function normalizeHostPortConnectionLocator(locator: HostPortConnectionLocator): string {
  const host = normalizeSshHost(locator.sshHost);
  if (!host) throw new Error("Cannot identify a host-port target without an SSH host");
  const port = locator.sshPort ?? 22;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Cannot identify a host-port target with an invalid SSH port");
  }
  const jumpHost = locator.sshJumpHost ? normalizeSshHost(locator.sshJumpHost) : "";
  // Extra connection options can carry a ProxyJump that is not represented by
  // sshJumpHost. Collapse whitespace for stability, but do not lowercase paths.
  const sshArgs = locator.sshArgs?.trim().replace(/\s+/g, " ") ?? "";
  return `ssh://${host}:${port}?jump=${encodeURIComponent(jumpHost)}&args=${encodeURIComponent(sshArgs)}`;
}

function fingerprint(
  source: "machine-id" | "openship-host-id" | "connection",
  value: string,
): string {
  return createHash("sha256").update(`${source}\0${value}`, "utf8").digest("hex");
}

/** Immutable identity for the SSH endpoint recorded in a server row. Unlike a
 *  server id, this changes when that row is repointed, so deferred destructive
 *  work can fail closed instead of following the alias to another machine. */
export function connectionHostPortTargetKey(locator: HostPortConnectionLocator): HostPortTargetKey {
  return `host:${fingerprint("connection", normalizeHostPortConnectionLocator(locator))}`;
}

async function readValidatedTargetId(
  executor: CommandExecutor,
): Promise<{ source: "machine-id" | "openship-host-id"; value: string } | null> {
  const cached = stableTargetIds.get(executor);
  if (cached) return cached;
  // machine-id is the OS-issued, normally world-readable identity. Prefer it so
  // all SSH users converge even when a private OpenShip host-id has narrower
  // permissions. The OpenShip id is the stable fallback for targets without one.
  try {
    const machineId = normalizeTargetMachineId(await executor.readFile(MACHINE_ID_PATH));
    if (machineId) {
      const found = { source: "machine-id" as const, value: machineId };
      stableTargetIds.set(executor, found);
      return found;
    }
  } catch {
    // Fall through to the existing OpenShip target id, then the locator.
  }
  try {
    const hostId = normalizeTargetHostId(await executor.readFile(OPENSHIP_HOST_ID_PATH));
    if (hostId) {
      const found = { source: "openship-host-id" as const, value: hostId };
      stableTargetIds.set(executor, found);
      return found;
    }
  } catch {
    // A deterministic connection locator is the last-resort identity.
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Persist a target-issued identity when the OS has no readable machine-id.
 *
 * The noclobber create is atomic across API replicas and duplicate server rows:
 * one candidate wins, every caller reads the winner. Try the login first and
 * then passwordless sudo, matching the privilege contract required to manage
 * the edge on that same host. Failure is non-destructive and falls back to an
 * explicitly unstable connection identity below.
 */
async function ensureTargetHostId(executor: CommandExecutor): Promise<string | null> {
  const candidate = randomUUID();
  const dir = "/var/lib/openship";
  const path = OPENSHIP_HOST_ID_PATH;
  const script =
    `umask 022; mkdir -p ${shellQuote(dir)}; ` +
    `if [ ! -e ${shellQuote(path)} ]; then ` +
    `(set -C; printf '%s\\n' ${shellQuote(candidate)} > ${shellQuote(path)}) 2>/dev/null || true; ` +
    `fi; cat ${shellQuote(path)}`;
  for (const command of [script, `sudo -n sh -c ${shellQuote(script)}`]) {
    try {
      const value = normalizeTargetHostId(await executor.exec(command));
      if (value) return value;
    } catch {
      // Try the elevated form, then return an unstable locator identity.
    }
  }
  return null;
}

export const LOCAL_HOST_PORT_TARGET: HostPortTargetIdentity = Object.freeze({
  targetKey: "local",
  legacyTargetKeys: [],
  stable: true,
});

/**
 * Resolve a remote server row to the physical machine it reaches.
 *
 * Server ids are mutable database aliases, so they are never the authority for
 * new claims. A target-issued id survives row deletion/recreation and lets two
 * rows that reach the same machine share one lock and collision domain.
 */
export async function resolveHostPortTargetIdentity(input: {
  localHost: boolean;
  serverId: string | null;
  executor: CommandExecutor | null;
  connection: HostPortConnectionLocator | null;
}): Promise<HostPortTargetIdentity> {
  if (input.localHost) return LOCAL_HOST_PORT_TARGET;
  if (!input.serverId || !input.executor || !input.connection) {
    throw new Error("Cannot resolve a remote host-port target without its server and executor");
  }

  let stableId = await readValidatedTargetId(input.executor);
  if (!stableId) {
    const created = await ensureTargetHostId(input.executor);
    if (created) {
      stableId = { source: "openship-host-id", value: created };
      stableTargetIds.set(input.executor, stableId);
    }
  }
  const physicalFingerprint = stableId
    ? fingerprint(stableId.source, stableId.value)
    : connectionHostPortTargetKey(input.connection).slice("host:".length);

  return {
    targetKey: `host:${physicalFingerprint}`,
    legacyTargetKeys: [`server:${input.serverId}`],
    stable: Boolean(stableId),
  };
}
