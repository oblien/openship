import { readServerStats, type CommandExecutor } from "@repo/adapters";
import type { CloudWorkspaceUsage } from "@repo/contracts";

export function unavailableServerUsage(reason: string): CloudWorkspaceUsage {
  return {
    measuredAt: new Date().toISOString(),
    available: false,
    reason,
    cpuPercent: null,
    memoryUsedMb: null,
    memoryAvailableMb: null,
    diskUsedMb: null,
    diskAvailableMb: null,
    diskTotalMb: null,
    sharedDiskMb: null,
    projects: [],
  };
}

/** Convert the shared host sample once; purchased disk is never a measurement. */
export async function sampleServerUsage(executor: CommandExecutor): Promise<CloudWorkspaceUsage> {
  const stats = await readServerStats(executor);
  return {
    ...unavailableServerUsage(""),
    available: true,
    reason: null,
    cpuPercent: stats.cpu,
    memoryUsedMb: stats.memUsed / 1048576,
    memoryAvailableMb: stats.memAvail / 1048576,
    diskUsedMb: stats.diskUsed / 1048576,
    diskAvailableMb: stats.diskAvail / 1048576,
    diskTotalMb: stats.diskTotal / 1048576,
  };
}
