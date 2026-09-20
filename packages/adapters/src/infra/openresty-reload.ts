import { safeErrorMessage } from "@repo/core";
import type { CommandExecutor } from "../types";
import {
  describeProcess,
  probeListeningPortOwners,
  type PortOccupant,
} from "../runtime/port-conflict";
import { sq } from "../system/local-shell";
import type { OpenRestyPaths } from "./openresty-lua";

const NGINX_MASTER_RE = /\b(?:nginx|openresty)\s*:\s*master process/i;
const NGINX_WORKER_RE = /\b(?:nginx|openresty)\s*:\s*worker process/i;
const NGINX_PROCESS_RE = /\b(?:nginx|openresty)\b/i;

type NginxProcessIdentity = "match" | "foreign" | "unknown";

async function canonicalRemotePath(
  executor: CommandExecutor,
  path: string,
): Promise<string | null> {
  const resolved = await executor
    .exec(`readlink -f ${sq(path)} 2>/dev/null || true`, { timeout: 5_000 })
    .catch(() => "");
  return resolved.trim() || null;
}

/** `undefined` means compiled default; `null` means an unsafe/unresolved -c. */
function explicitNginxConfig(rawCommand: string): string | null | undefined {
  const match = rawCommand.match(/(?:^|\s)-c(?:(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))|(\S+))/);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
  // A relative -c is resolved against nginx's prefix, which is not safely
  // recoverable from a process title alone. Refuse instead of guessing.
  return value.startsWith("/") ? value : null;
}

function hasExplicitNginxPrefix(rawCommand: string): boolean {
  return /(?:^|\s)-p(?:\s+|=|\S)/.test(rawCommand);
}

async function processStartTime(executor: CommandExecutor, pid: number): Promise<string | null> {
  const value = await executor
    .exec(
      `awk '{ line=$0; sub(/^.*\\) /, "", line); split(line, fields, " "); print fields[20] }' /proc/${pid}/stat 2>/dev/null || true`,
      { timeout: 5_000 },
    )
    .catch(() => "");
  return /^\d+$/.test(value.trim()) ? value.trim() : null;
}

/**
 * Prove this is the exact nginx/OpenResty installation (and config, when -c is
 * explicit) whose configuration we just validated. A process name or unit name
 * alone is insufficient: a box may run a foreign system nginx beside the legacy
 * Openship OpenResty installation.
 */
async function verifyNginxProcessIdentity(
  executor: CommandExecutor,
  occupant: PortOccupant,
  paths: OpenRestyPaths,
): Promise<NginxProcessIdentity> {
  if (!occupant.pid) return "unknown";
  const rawCommand = occupant.rawCommand?.trim();
  // `ps ... comm=` only says "nginx" and loses -c/-p. Only the complete
  // master process title proves which invocation/configuration is running.
  if (!rawCommand || !NGINX_MASTER_RE.test(rawCommand)) return "unknown";
  const [actualExe, expectedExe] = await Promise.all([
    canonicalRemotePath(executor, `/proc/${occupant.pid}/exe`),
    canonicalRemotePath(executor, paths.bin),
  ]);
  if (!actualExe || !expectedExe) return "unknown";
  if (actualExe !== expectedExe) return "foreign";

  // `-p` changes how the default config and its relative includes are resolved.
  // The validation command did not carry that prefix, so it did not prove the
  // running instance's configuration and we cannot safely signal it.
  if (hasExplicitNginxPrefix(rawCommand)) return "unknown";
  const explicitConfig = explicitNginxConfig(rawCommand);
  if (explicitConfig === null) return "unknown";
  // With no `-c`, HUP makes nginx read its compiled --conf-path—not whichever
  // existing fallback detectOpenRestyPaths selected for file management. Prove
  // that the invocation's effective config and the validated config are the
  // same canonical file in both cases.
  const effectiveConfig = explicitConfig ?? paths.compiledConfPath;
  const [actualConfig, expectedConfig] = await Promise.all([
    canonicalRemotePath(executor, effectiveConfig),
    canonicalRemotePath(executor, paths.confPath),
  ]);
  if (!actualConfig || !expectedConfig || actualConfig !== expectedConfig) return "unknown";
  return "match";
}

/**
 * `ss` commonly attributes nginx's inherited listen socket to a worker. A HUP
 * belongs to the master, so resolve exactly one parent hop and verify its role;
 * never walk blindly toward systemd/PID 1.
 */
async function resolveListeningNginxMaster(
  executor: CommandExecutor,
  occupant: PortOccupant,
): Promise<PortOccupant> {
  const description = `${occupant.rawCommand ?? ""} ${occupant.command}`;
  if (!occupant.pid || !NGINX_WORKER_RE.test(description)) return occupant;

  const rawParent = await executor
    .exec(`awk '/^PPid:/{print $2}' /proc/${occupant.pid}/status 2>/dev/null || true`)
    .catch(() => "");
  const parentPid = Number.parseInt(rawParent.trim(), 10);
  if (!Number.isInteger(parentPid) || parentPid <= 1) return occupant;

  const parent = await describeProcess(executor, parentPid).catch(() => null);
  if (!parent) return occupant;
  const parentDescription = `${parent.rawCommand ?? ""} ${parent.command}`;
  return NGINX_MASTER_RE.test(parentDescription) ? parent : occupant;
}

export interface BareOpenRestyReloadOptions {
  /** Route removals may converge on disk when the managed host daemon is stopped. */
  allowStopped?: boolean;
}

/**
 * Validate and gracefully reload a BARE host OpenResty without trusting its PID
 * file. `nginx -s reload` reads that mutable file and can HUP an unrelated process
 * after PID reuse, so bare lifecycle code never invokes it. Instead this proves the
 * live :80/:443 master belongs to the exact host executable/config, binds that proof
 * to `/proc/<pid>/stat` starttime, and rechecks immediately before HUP.
 */
export async function reloadBareOpenResty(
  executor: CommandExecutor,
  paths: OpenRestyPaths,
  opts: BareOpenRestyReloadOptions = {},
): Promise<void> {
  // Always name the config we are about to reload. Path detection can recover an
  // installation whose compiled default moved after an upgrade; relying on bare
  // `-t` there would validate one tree and then HUP a master using another.
  await executor.exec(`${sq(paths.bin)} -t -c ${sq(paths.confPath)} 2>&1`, {
    timeout: 15_000,
  });

  const listenerStates = await Promise.all([
    probeListeningPortOwners(executor, 80),
    probeListeningPortOwners(executor, 443),
  ]);
  if (listenerStates.some((state) => !state.checked)) {
    throw new Error(
      "OpenResty config is valid, but the port 80/443 listener probe was inconclusive; refusing to assume the managed daemon is stopped.",
    );
  }
  if (listenerStates.some((state) => !state.ownershipComplete)) {
    throw new Error(
      "OpenResty config is valid, but every listener on port 80/443 could not be identified; refusing to signal an unknown or mixed owner.",
    );
  }
  const occupants = listenerStates.flatMap((state) => state.occupants);

  const verifiedMasters = new Map<
    number,
    { pid: number; startTime: string; processCgroup: string }
  >();
  let foreignListenerOwner = false;
  let ambiguousNginxOwner = false;
  let containerBackedNginxOwner = false;
  for (const occupant of occupants) {
    if (!occupant.rawCommand?.trim()) {
      ambiguousNginxOwner = true;
      continue;
    }
    const description = [
      occupant.rawCommand,
      occupant.command,
      occupant.systemdUnit,
      occupant.systemdDescription,
    ]
      .filter(Boolean)
      .join(" ");
    if (!NGINX_PROCESS_RE.test(description)) {
      foreignListenerOwner = true;
      continue;
    }
    if (occupant.containerId) {
      containerBackedNginxOwner = true;
      continue;
    }

    const master = await resolveListeningNginxMaster(executor, occupant);
    if (master.containerId) {
      containerBackedNginxOwner = true;
      continue;
    }

    // Classify a process from another installation without requiring proc stat;
    // every potentially managed process must then survive generation-bound
    // executable/config verification before it is signalable.
    const initialIdentity = await verifyNginxProcessIdentity(executor, master, paths);
    if (initialIdentity === "foreign") {
      foreignListenerOwner = true;
      continue;
    }
    if (initialIdentity === "unknown" || !master.pid) {
      ambiguousNginxOwner = true;
      continue;
    }
    if (master.cgroupVerified !== true || !master.processCgroup) {
      ambiguousNginxOwner = true;
      continue;
    }

    const startTime = await processStartTime(executor, master.pid);
    if (!startTime) {
      ambiguousNginxOwner = true;
      continue;
    }

    // Refresh args + cgroup AFTER capturing the generation. Reusing the stale
    // listener/master description would let a replacement process inherit the
    // old process's `-c` arguments. Bracket the refreshed description with the
    // same starttime so it and the identity proof refer to one process lifetime.
    const refreshedMaster = await describeProcess(executor, master.pid).catch(() => null);
    const confirmedStartTime = await processStartTime(executor, master.pid);
    if (
      !refreshedMaster ||
      confirmedStartTime !== startTime ||
      refreshedMaster.cgroupVerified !== true ||
      !refreshedMaster.processCgroup
    ) {
      ambiguousNginxOwner = true;
      continue;
    }
    if (refreshedMaster.containerId) {
      containerBackedNginxOwner = true;
      continue;
    }
    const identity = await verifyNginxProcessIdentity(executor, refreshedMaster, paths);
    if (identity !== "match") {
      ambiguousNginxOwner = true;
      continue;
    }
    verifiedMasters.set(master.pid, {
      pid: master.pid,
      startTime,
      processCgroup: refreshedMaster.processCgroup,
    });
  }

  if (containerBackedNginxOwner) {
    throw new Error(
      "A container-backed nginx/OpenResty listener owns port 80/443; refusing to signal it from bare-host reload.",
    );
  }
  if (ambiguousNginxOwner) {
    throw new Error(
      "A live nginx/OpenResty listener was found, but its executable and configuration could not be verified, or its host ownership could not be proven; refusing to signal an ambiguous process.",
    );
  }
  if (foreignListenerOwner) {
    throw new Error(
      verifiedMasters.size > 0
        ? "The managed OpenResty master shares ports 80/443 with a foreign listener; refusing a reload that cannot apply the validated configuration safely."
        : "A foreign listener owns port 80/443; refusing to treat a live daemon as stopped or report the managed route reload as complete.",
    );
  }
  if (verifiedMasters.size === 0) {
    // `allowStopped` is only permission to converge the managed config on disk
    // when the ports are genuinely empty. It is never permission to ignore a
    // live foreign/ambiguous owner (those cases fail above).
    if (opts.allowStopped && occupants.length === 0) return;
    const owners = occupants.map((occupant) => occupant.command).filter(Boolean);
    throw new Error(
      "OpenResty config is valid, but no verified bare-host master is listening on port 80/443" +
        (owners.length > 0 ? ` (found: ${owners.join(", ")})` : "") +
        "; refusing to start a second daemon.",
    );
  }
  if (verifiedMasters.size !== 1) {
    throw new Error(
      `Found ${verifiedMasters.size} verified nginx/OpenResty masters on ports 80/443; refusing an ambiguous reload.`,
    );
  }

  const target = [...verifiedMasters.values()][0]!;
  // Re-check both immutable process start time and executable immediately before
  // HUP. If the master exited and Linux reused its PID, this fails rather than
  // signalling the replacement process. No nginx CLI/pidfile is involved.
  await executor
    .exec(
      `current_exe=$(readlink -f /proc/${target.pid}/exe 2>/dev/null || true); ` +
        `expected_exe=$(readlink -f ${sq(paths.bin)} 2>/dev/null || true); ` +
        `current_start=$(awk '{ line=$0; sub(/^.*\\) /, "", line); split(line, fields, " "); print fields[20] }' /proc/${target.pid}/stat 2>/dev/null || true); ` +
        `current_cgroup=$(cat /proc/${target.pid}/cgroup 2>/dev/null) || { echo "nginx master cgroup became unreadable; refusing reload" >&2; exit 1; }; ` +
        `[ -n "$current_exe" ] && [ "$current_exe" = "$expected_exe" ] && ` +
        `[ "$current_start" = ${sq(target.startTime)} ] && ` +
        `[ -n "$current_cgroup" ] && [ "$current_cgroup" = ${sq(target.processCgroup)} ] || ` +
        `{ echo "nginx master identity changed; refusing reload" >&2; exit 1; }; ` +
        `kill -HUP ${target.pid}`,
      { timeout: 5_000 },
    )
    .catch((err) => {
      throw new Error(`Safe bare-host OpenResty reload failed: ${safeErrorMessage(err)}`);
    });
}
