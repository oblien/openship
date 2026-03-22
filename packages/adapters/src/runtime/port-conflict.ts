import { DeployError } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { PromptUserFn } from "./deploy-pipeline";

export interface PortOccupant {
  pid: number;
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

  if (!systemdUnit) {
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
  } else {
    logger.log(`Killing ${occupant.command} to free port...\n`);
    await executor.exec(`kill -9 ${occupant.pid} 2>/dev/null || true`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Probe what process (if any) is listening on a port.
 * Uses `ss` first and falls back to `lsof` when available.
 */
export async function probeListeningPort(
  executor: CommandExecutor,
  port: number,
): Promise<PortOccupant | null> {
  try {
    const out = await executor.exec(
      `ss -tlnp sport = :${port} 2>/dev/null | grep LISTEN || lsof -ti tcp:${port} 2>/dev/null || true`,
    );

    const ssMatch = out.match(/pid=(\d+)/);
    const lsofMatch = !ssMatch ? out.trim().match(/^(\d+)$/) : null;
    const pid = ssMatch
      ? parseInt(ssMatch[1], 10)
      : lsofMatch
        ? parseInt(lsofMatch[1], 10)
        : null;

    if (!pid) return null;

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
  } catch {
    return null;
  }
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