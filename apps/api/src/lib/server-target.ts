import { repos, type Project } from "@repo/db";
import { env } from "../config/env";

interface DeploymentSnapshotLike {
  serverId?: string;
}

async function resolveSnapshotServerHost(snapshot?: DeploymentSnapshotLike | null): Promise<string | null> {
  if (snapshot?.serverId) {
    const server = await repos.server.get(snapshot.serverId);
    if (server?.sshHost) return server.sshHost;
  }

  return env.SERVER_IP ?? null;
}

export async function resolveServerHost(serverId?: string): Promise<string | null> {
  return resolveSnapshotServerHost(serverId ? { serverId } : null);
}

export async function resolveProjectServerHost(project?: Project): Promise<string | null> {
  if (!project) return env.SERVER_IP ?? null;

  const deployment = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : await repos.deployment.findLatestByProject(project.id);

  const snapshot = (deployment?.meta ?? null) as DeploymentSnapshotLike | null;
  return resolveSnapshotServerHost(snapshot);
}