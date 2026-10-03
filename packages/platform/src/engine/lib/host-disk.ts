/**
 * How much room is left where a deploy host stores its images and releases.
 *
 * Deliberately NOT part of host-capacity: that module is asserted to be
 * shell-free (see test/lib/host-capacity-cloud-guard.test.ts) because it sits on
 * the path of every resource read with a caller-supplied serverId. Free disk
 * can't be read over the Docker API — `docker system df` reports what Docker is
 * USING, not what the filesystem has left — so it needs a `df`, and that shell
 * boundary lives here where it can be reasoned about on its own.
 *
 * SAFETY: `DISK_COMMAND` is a CONSTANT string. Nothing is interpolated into it —
 * the path it measures is resolved ON the host by `docker info` (falling back to
 * the conventional data root, then `/`), so there is no injection surface even
 * though `serverId` comes from a caller. Server selection stays org-scoped by
 * the shared server execution boundary.
 *
 * Advisory by contract: the rollback UI displays this measurement; it never
 * changes the configured retention window. Never throws.
 */

import { env } from "../config/env";
import { cacheStore } from "./cache-store/index";
import { resolveServerExecutor } from "./deployment-runtime";
import { withServerExecution } from "./server-execution";

/** This advisory rollback detail can reuse a recent host measurement. */
const TTL_SECONDS = 5 * 60;
const NAMESPACE = "host-disk";

/**
 * Measure the filesystem that actually holds Docker's data — a box whose images
 * live on a mounted data volume would otherwise be sized against `/`.
 *
 * `df -Pk` is POSIX (portable across Linux and macOS, unlike `-B1`) and prints
 * 1K blocks: `$2` total, `$4` available.
 */
const DISK_COMMAND =
  'root="$(docker info --format "{{.DockerRootDir}}" 2>/dev/null)"; ' +
  '[ -d "$root" ] || root=/var/lib/docker; [ -d "$root" ] || root=/; ' +
  "df -Pk \"$root\" 2>/dev/null | awk 'NR==2{print $2,$4}'";

export interface HostDisk {
  /** Total bytes on the filesystem holding the runtime's data. Null = unknown. */
  totalBytes: number | null;
  /** Free bytes on it. Null = unknown. */
  freeBytes: number | null;
}

export const UNKNOWN_DISK: HostDisk = { totalBytes: null, freeBytes: null };

function cacheKey(serverId: string | undefined, organizationId: string): string {
  return `${organizationId}:${serverId ?? "__default__"}`;
}

function parseDf(output: string): HostDisk {
  const [totalKb, freeKb] = output.trim().split(/\s+/).map((n) => Number(n));
  if (!Number.isFinite(totalKb) || totalKb <= 0 || !Number.isFinite(freeKb) || freeKb < 0 || freeKb > totalKb)
    return { ...UNKNOWN_DISK };
  return { totalBytes: totalKb * 1024, freeBytes: freeKb * 1024 };
}

/**
 * Free/total disk on the machine a project deploys to, cached.
 *
 * Managed hosts use their owned provider executor. Missing Cloud selection
 * must never fall back to the control plane's local filesystem.
 */
export async function getHostDisk(
  serverId: string | undefined,
  organizationId: string,
  opts?: { refresh?: boolean },
): Promise<HostDisk> {
  if (env.CLOUD_MODE && !serverId) return { ...UNKNOWN_DISK };

  const key = cacheKey(serverId, organizationId);
  const store = await cacheStore<HostDisk>(NAMESPACE, { maxSize: 500 });

  if (!opts?.refresh) {
    const hit = await store.get(key);
    if (hit) return hit;
  }

  try {
    const read = async (executor: import("@repo/adapters").CommandExecutor) =>
      parseDf(await executor.exec(DISK_COMMAND, { timeout: 10_000 }));
    const disk = env.CLOUD_MODE
      ? await withServerExecution(organizationId, serverId!, read)
      : await read((await resolveServerExecutor(serverId, organizationId)).executor);
    // Only cache a real answer, so a briefly-unreachable box doesn't pin
    // "unknown" for the whole TTL.
    if (disk.freeBytes !== null) await store.set(key, disk, TTL_SECONDS).catch(() => {});
    return disk;
  } catch {
    return { ...UNKNOWN_DISK };
  }
}
