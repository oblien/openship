import { DeployError } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { PromptUserFn } from "./deploy-pipeline";

export interface PortOccupant {
  pid: number;
  command: string;
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
    try {
      const cmd = await executor.exec(`ps -p ${pid} -o comm= 2>/dev/null`);
      if (cmd.trim()) command = `${cmd.trim()} (PID ${pid})`;
    } catch {
      // Best-effort enrichment only.
    }

    return { pid, command };
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

  const action = await promptUser({
    promptId: `port_in_use:${port}`,
    title: "Port In Use",
    message: `Port ${port} is occupied by ${occupant.command}. This may not be a previous deployment.`,
    actions: [
      { id: "free_port", label: "Free Port & Continue", variant: "danger" },
      { id: "abort", label: "Cancel Deploy", variant: "secondary" },
    ],
    details: { port, pid: occupant.pid, command: occupant.command },
  });

  if (action === "free_port") {
    logger.log(`User chose to free port ${port} - killing ${occupant.command}...\n`);
    await executor.exec(`kill -9 ${occupant.pid} 2>/dev/null || true`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return;
  }

  throw new DeployError(
    `Deploy aborted: port ${port} is in use by ${occupant.command}`,
    "PORT_IN_USE",
    { port, pid: occupant.pid, command: occupant.command },
  );
}