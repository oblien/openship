import { DeployError } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { PromptUserFn } from "./deploy-pipeline";
import { probePortListeningOnce } from "../system/port-listen";

export interface PortOccupant {
  /** Owner PID, or `null` when the port is listening but its owner couldn't be
   *  resolved (procfs-only fallback / non-root ss) — occupancy is still known. */
  pid: number | null;
  command: string;
  rawCommand?: string;
  systemdUnit?: string;
  systemdDescription?: string;
  deploymentId?: string;
  isManagedDeployment?: boolean;
}

const OPENSHIP_UNIT_PREFIX = "openship-";

async function tryExec(executor: CommandExecutor, command: string): Promise<string | null> {
  try {
    return await executor.exec(command);
  } catch {
    return null;
  }
}

async function resolveSystemdUnit(
  executor: CommandExecutor,
  pid: number,
): Promise<Pick<PortOccupant, "systemdUnit" | "systemdDescription" | "deploymentId" | "isManagedDeployment">> {
  const cgroup = await tryExec(executor, `cat /proc/${pid}/cgroup 2>/dev/null || true`);
  const unitMatch = cgroup?.match(/(?:^|\/)([^/\n]+\.service)(?:$|\n|\/)/m)
    ?? cgroup?.match(/(?:^|\/)([^/\n]+\.service)(?:$|\n|\/)/m);
  const systemdUnit = unitMatch?.[1]?.trim();

  // Reject anything that isn't a plain systemd unit name — the value is parsed
  // from /proc text and later interpolated into `systemctl` commands, so a
  // crafted cgroup leaf must never carry shell metacharacters through.
  if (!systemdUnit || !/^[A-Za-z0-9@._:\\-]+\.service$/.test(systemdUnit)) {
    return {};
  }

  const description = await tryExec(
    executor,
    `systemctl show ${systemdUnit} --property=Description --value 2>/dev/null || true`,
  );
  const managedMatch = systemdUnit.match(/^openship-(.+)\.service$/);

  return {
    systemdUnit,
    systemdDescription: description?.trim() || undefined,
    deploymentId: managedMatch?.[1],
    isManagedDeployment: Boolean(managedMatch),
  };
}

async function freePortOccupant(
  executor: CommandExecutor,
  occupant: PortOccupant,
  logger: BuildLogger,
): Promise<void> {
  if (occupant.systemdUnit) {
    logger.log(`Stopping systemd unit ${occupant.systemdUnit} to free port...\n`);
    await executor.exec(
      `systemctl stop ${occupant.systemdUnit} 2>/dev/null || true; systemctl reset-failed ${occupant.systemdUnit} 2>/dev/null || true`,
    );
  } else if (occupant.pid) {
    logger.log(`Killing ${occupant.command} to free port...\n`);
    await executor.exec(`kill -9 ${occupant.pid} 2>/dev/null || true`);
  } else {
    logger.log(`Can't free port automatically: ${occupant.command} (owner PID unknown).\n`, "warn");
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Find who (if anyone) is LISTENing on `port`, via a tiered fallback so the
 * probe behaves consistently regardless of which tools a host ships:
 *   1. `ss -l`             — Linux (iproute2, ~always present); yields the PID.
 *   2. `lsof -sTCP:LISTEN` — macOS + any Linux with lsof; yields the PID.
 *   3. `/proc/net/tcp{,6}` — tool-free kernel socket table; presence only.
 *
 * Every tier is LISTEN-state filtered, so an outbound/ESTABLISHED socket on the
 * port (e.g. a daemon dialing a remote :443) is never mistaken for an occupant —
 * that filtering is the whole point of keeping this in ONE place. Tiers 1–2 are
 * a single exec; tier 3 (reused from `port-listen`) runs only when no PID
 * surfaced, and is what prevents a false "port free" on a host missing both `ss`
 * and `lsof`, or when non-root `ss` prints the listener but hides its PID.
 */
async function resolveListener(
  executor: CommandExecutor,
  port: number,
): Promise<{ pid: number | null; occupied: boolean }> {
  const out = await tryExec(
    executor,
    `ss -tlnp sport = :${port} 2>/dev/null | grep LISTEN || lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`,
  );
  if (out) {
    const ssMatch = out.match(/pid=(\d+)/);
    // lsof -ti prints one bare PID per line; take the first. An ss LISTEN line
    // is never a bare number, so this can't mis-parse the ss branch.
    const lsofMatch = !ssMatch ? out.match(/^\s*(\d+)\s*$/m) : null;
    const pid = ssMatch
      ? parseInt(ssMatch[1], 10)
      : lsofMatch
        ? parseInt(lsofMatch[1], 10)
        : null;
    if (pid) return { pid, occupied: true };
  }
  // Tier 3: authoritative presence check with no tool dependency. `true` = a
  // LISTEN socket exists; `false`/`null` (no signal) → treat as free.
  const listening = await probePortListeningOnce(executor, port);
  return { pid: null, occupied: listening === true };
}

/**
 * Probe what process (if any) is listening on a port — see `resolveListener` for
 * the ss → lsof → procfs fallback. Returns `null` when the port is free. When
 * something is listening but its owner can't be resolved, returns an occupant
 * with `pid: null` + an "unknown listener" label, so the port is never treated
 * as free even though there's no PID to act on.
 */
export async function probeListeningPort(
  executor: CommandExecutor,
  port: number,
): Promise<PortOccupant | null> {
  try {
    const { pid, occupied } = await resolveListener(executor, port);
    if (!occupied) return null;
    if (pid === null) return { pid: null, command: "unknown listener" };
    return await describeProcess(executor, pid);
  } catch {
    return null;
  }
}

/**
 * Identify one PID the same way `probeListeningPort` identifies a port's owner —
 * args/comm label plus its systemd unit. Split out so a caller that resolved a
 * different PID than the raw listener (e.g. the edge probe walking an nginx
 * worker up to its master) describes it through the SAME path, rather than
 * hand-rolling a second `ps` + cgroup read.
 */
export async function describeProcess(
  executor: CommandExecutor,
  pid: number,
): Promise<PortOccupant> {
  let command = `PID ${pid}`;
  let rawCommand: string | undefined;
  const args = await tryExec(executor, `ps -p ${pid} -o args= 2>/dev/null || true`);
  if (args?.trim()) {
    rawCommand = args.trim();
    command = `${rawCommand} (PID ${pid})`;
  } else {
    const cmd = await tryExec(executor, `ps -p ${pid} -o comm= 2>/dev/null || true`);
    if (cmd?.trim()) {
      rawCommand = cmd.trim();
      command = `${rawCommand} (PID ${pid})`;
    }
  }

  const systemd = await resolveSystemdUnit(executor, pid);
  return { pid, command, rawCommand, ...systemd };
}

/**
 * Ensure a port is free before deploy. If occupied, pause for user input.
 */
export async function ensurePortAvailable(
  executor: CommandExecutor,
  port: number,
  logger: BuildLogger,
  promptUser: PromptUserFn,
): Promise<void> {
  const occupant = await probeListeningPort(executor, port);
  if (!occupant) return;

  logger.log(`Port ${port} is occupied by ${occupant.command}. Waiting for user decision...\n`, "warn");

  const freeActionLabel = occupant.isManagedDeployment
    ? "Stop Openship Deployment & Continue"
    : occupant.systemdUnit
      ? "Stop Service & Continue"
      : "Free Port & Continue";

  const action = await promptUser({
    promptId: `port_in_use:${port}`,
    title: "Port In Use",
    message: `Port ${port} is occupied by ${occupant.command}. This may not be a previous deployment.`,
    actions: [
      { id: "free_port", label: freeActionLabel, variant: "danger" },
      { id: "abort", label: "Cancel Deploy", variant: "secondary" },
    ],
    details: {
      port,
      pid: occupant.pid,
      command: occupant.command,
      rawCommand: occupant.rawCommand,
      systemdUnit: occupant.systemdUnit,
      systemdDescription: occupant.systemdDescription,
      deploymentId: occupant.deploymentId,
      isManagedDeployment: occupant.isManagedDeployment,
    },
  });

  if (action === "free_port") {
    logger.log(`User chose to free port ${port} from ${occupant.command}...\n`);
    await freePortOccupant(executor, occupant, logger);

    const remaining = await probeListeningPort(executor, port);
    if (!remaining) {
      return;
    }

    throw new DeployError(
      `Port ${port} is still in use by ${remaining.command}. Stop the existing process before deploying.`,
      "PORT_IN_USE",
      {
        port,
        pid: remaining.pid,
        command: remaining.command,
        rawCommand: remaining.rawCommand,
        systemdUnit: remaining.systemdUnit,
        systemdDescription: remaining.systemdDescription,
        deploymentId: remaining.deploymentId,
        isManagedDeployment: remaining.isManagedDeployment,
      },
    );

    return;
  }

  throw new DeployError(
    `Deploy aborted: port ${port} is in use by ${occupant.command}`,
    "PORT_IN_USE",
    {
      port,
      pid: occupant.pid,
      command: occupant.command,
      rawCommand: occupant.rawCommand,
      systemdUnit: occupant.systemdUnit,
      systemdDescription: occupant.systemdDescription,
      deploymentId: occupant.deploymentId,
      isManagedDeployment: occupant.isManagedDeployment,
    },
  );
}