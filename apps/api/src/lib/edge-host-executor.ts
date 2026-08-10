/**
 * One reader for "the box this project's edge lives on".
 *
 * Anything that inspects or manipulates the edge — certbot's store, the
 * OpenResty vhosts, the live proxy config — has to run on the HOST those files
 * sit on, which is not necessarily where the API process runs. Two callers need
 * it (cert reuse in `domain.service`, live config read-back in
 * `edge-config.service`), so it lives here rather than being copied: a second
 * copy is how one of them ends up leaking sshd sessions again (#291).
 */

import { repos, type Project } from "@repo/db";
import type { CommandExecutor } from "@repo/adapters";

import type { DeploymentMeta } from "./deployment-runtime";
import { sshManager } from "./ssh-manager";

/** The server the project's active deployment runs on (for edge/cert reads). */
export async function resolveServerIdForProject(project: Project): Promise<string | null> {
  if (!project.activeDeploymentId) return null;
  const dep = await repos.deployment.findById(project.activeDeploymentId).catch(() => null);
  return (dep?.meta as DeploymentMeta | undefined)?.serverId ?? null;
}

/**
 * Run `fn` with an executor that reaches the BOX the project's edge lives on —
 * the same host the bare/containerized OpenResty + certbot + /etc/letsencrypt sit
 * on. For the auto-registered "this server" (server-host mode) that's the LOCAL
 * host (SSH-to-host when the API is itself containerized); for a real remote
 * server it's the pooled SSH executor. Returns null when there's no server or the
 * box is unreachable. This is what lets cert reuse read the HOST's
 * /etc/letsencrypt even when the API runs in a container whose own
 * /etc/letsencrypt is a different (empty) volume.
 */
export async function withServerHostExecutor<T>(
  project: Project,
  fn: (exec: CommandExecutor) => Promise<T>,
): Promise<T | null> {
  const serverId = await resolveServerIdForProject(project);
  if (!serverId) return null;
  // No local/remote branch: `acquire` already returns the pooled HOST channel for a
  // local row. The old branch handed out a fresh `createHostExecutor()` per call and
  // never closed it — one leaked sshd session per domain/SSL status read (#291).
  return sshManager.withExecutor(serverId, fn).catch(() => null);
}
