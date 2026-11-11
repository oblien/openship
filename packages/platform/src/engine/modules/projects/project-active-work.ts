import { repos } from "@repo/db";

/** Read every durable resource-mutating owner; unreadable state fails closed. */
export async function readActiveProjectWork(projectId: string) {
  const [activeDeployments, runs, restores, migration] = await Promise.all([
    repos.deployment.listInFlightByProject(projectId),
    repos.backupRun.listInFlightByProject(projectId),
    repos.backupRestore.listInFlightByProject(projectId),
    repos.dockerMigrationRun.findActiveForProject(projectId),
  ]);
  return { activeDeployments, runs, restores, migration };
}
