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
import { createExecutor, type CommandExecutor } from "@repo/adapters";

import { isLocalHostRow } from "./box-org";
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
 * the same host the bare/containerized OpenResty + certbot sit on. For the
 * auto-registered "this server" (server-host mode) that's the LOCAL host
 * (SSH-to-host when the API is itself containerized); for a real remote server it's
 * the pooled SSH executor. Returns null when there's no server or the box is
 * unreachable.
 *
 * Use this for anything that is genuinely the HOST's: the vhost tree (bind-mounted
 * into the api container at a DIFFERENT path), a foreign proxy's config, host
 * binaries. For a path the container shares 1:1 with its host, use
 * {@link withCertStoreExecutor} instead.
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

/**
 * Same, but for certbot's store — which the api container shares with its host at the
 * SAME path (`/etc/letsencrypt`, see `EDGE_CONTAINER_MOUNTS`).
 *
 * So on the local box `fn` reads the same files with no host channel in the path. That
 * matters more here than anywhere else the rule applies (`sharedMountExecutor`): when
 * the channel is firewalled or switched off, a cert that is sitting on disk stops being
 * adoptable and the domain falls through to ACME — which is rate-limited and fails
 * behind Cloudflare. The container runs as root, so the 0600 privkey.pem is readable.
 *
 * ONLY for that store. Nothing else project-scoped is a same-path mount, and reading a
 * translated path locally lands somewhere else entirely.
 */
export async function withCertStoreExecutor<T>(
  project: Project,
  fn: (exec: CommandExecutor) => Promise<T>,
): Promise<T | null> {
  const serverId = await resolveServerIdForProject(project);
  if (!serverId) return null;
  const row = await repos.server.get(serverId).catch(() => null);
  // isLocalHostRow, not `row.isLocal`: a plain loopback/SERVER_IP row for this box is
  // this box too, and it carries its own org gate so a teammate's org can't claim it.
  if (row && (await isLocalHostRow(row))) {
    return fn(createExecutor()).catch(() => null);
  }
  return sshManager.withExecutor(serverId, fn).catch(() => null);
}
