import type Dockerode from "dockerode";
import { AppError } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import type { CommandExecutor } from "../types";
import { projectBuildKitWorker } from "./docker-buildkit-worker";
import { sq } from "./build-pipeline";

export const DEFAULT_BUILD_CACHE_KEEP_BYTES = 5 * 1024 ** 3;
/** Cleanup headroom target; does not raise build admission limits. */
export const BUILD_STORAGE_GC_FREE_FRACTION = 0.2;
const CACHE_LABEL = "openship.build-cache";
const PROJECT_LABEL = "openship.build-cache.project";
const CACHE_AGE_MS = 7 * 24 * 60 * 60_000;
const STAMPS = "/var/lib/openship/build-cache";

export interface BuildStorage {
  totalBytes: number;
  freeBytes: number;
  freeInodes: number | null;
}

const BUILD_STORAGE_READ =
  '[ -d "$root" ] || exit 1; ' +
  `df -Pk "$root" | awk 'NR==2{print "OPENSHIP_STORAGE",$2,$4}'; ` +
  `df -Pi "$root" 2>/dev/null | awk 'NR==2{print "OPENSHIP_INODES",$2,$4}'`;

/** Measure the selected daemon's filesystem, never the control plane's. */
export const DOCKER_BUILD_STORAGE_COMMAND =
  'root="$(docker info --format "{{.DockerRootDir}}")"; ' + BUILD_STORAGE_READ;

/** The caller resolved this path through its Docker client before elevation. */
export function dockerBuildStorageCommand(root: string): string {
  return `root=${sq(root)}; ` + BUILD_STORAGE_READ;
}

export function parseBuildStorage(raw: string): BuildStorage {
  const lines = raw.trim().split(/\r?\n/);
  const marked = lines.find((line) => line.startsWith("OPENSHIP_STORAGE "));
  const values = marked
    ? `${marked.slice("OPENSHIP_STORAGE ".length)} ${lines.find((line) => line.startsWith("OPENSHIP_INODES "))?.slice("OPENSHIP_INODES ".length) ?? ""}`
    : raw.trim();
  const [totalKb, freeKb, totalInodes, freeInodes] = values.trim().split(/\s+/).map(Number);
  if (
    !Number.isSafeInteger(totalKb) ||
    totalKb! <= 0 ||
    !Number.isSafeInteger(freeKb) ||
    freeKb! < 0 ||
    freeKb! > totalKb!
  )
    throw new AppError(
      "Could not measure the build host's free storage",
      503,
      "BUILD_STORAGE_UNKNOWN",
    );
  return {
    totalBytes: totalKb! * 1024,
    freeBytes: freeKb! * 1024,
    // Filesystems without a fixed inode pool (such as Btrfs) can report all
    // zeros. Only a meaningful total can establish actual inode exhaustion.
    freeInodes:
      Number.isSafeInteger(totalInodes) &&
      totalInodes! > 0 &&
      Number.isSafeInteger(freeInodes) &&
      freeInodes! >= 0 &&
      freeInodes! <= totalInodes!
        ? freeInodes!
        : null,
  };
}

export function buildStorageReserve(storage: BuildStorage): number {
  return Math.min(2 * 1024 ** 3, Math.ceil(storage.totalBytes / 10));
}

/** Automatic cache ceiling scales down on small Docker filesystems. */
export function buildCacheKeepBytes(storage: BuildStorage): number {
  return Math.min(DEFAULT_BUILD_CACHE_KEEP_BYTES, Math.floor(storage.totalBytes / 10));
}

export function assertBuildStorage(storage: BuildStorage): void {
  if (storage.freeBytes < buildStorageReserve(storage) || storage.freeInodes === 0)
    throw new AppError(
      "The build host has too little free storage. Unused build caches were cleaned; free space or increase disk capacity before retrying. The current deployment has not been replaced.",
      409,
      "BUILD_STORAGE_LOW",
    );
}

type CacheDocker = Pick<Dockerode, "getVolume" | "createVolume" | "listVolumes" | "listContainers">;
export function projectBuildCacheVolume(projectId: string): string {
  return `${projectBuildKitWorker(projectId).containerName}_state`;
}
function stamp(name: string): string {
  return `${STAMPS}/${name}`;
}
function missing(error: unknown): boolean {
  return (error as { statusCode?: number })?.statusCode === 404;
}
function cacheOwner(volume: {
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string>;
}): string | undefined {
  const projectId = volume.Labels?.[PROJECT_LABEL];
  if (
    !projectId ||
    volume.Labels?.[CACHE_LABEL] !== "1" ||
    volume.Labels?.["openship.project"] !== undefined ||
    (volume.Driver && volume.Driver !== "local") ||
    volume.Name !== projectBuildCacheVolume(projectId)
  )
    return undefined;
  return projectId;
}

/** Names alone are not ownership. This also fences a concurrent create winner. */
export async function ensureProjectBuildCache(
  docker: CacheDocker,
  projectId: string,
): Promise<boolean> {
  const name = projectBuildCacheVolume(projectId);
  let reused = true;
  try {
    await docker.getVolume(name).inspect();
  } catch (error) {
    if (!missing(error)) throw error;
    reused = false;
    await docker.createVolume({
      Name: name,
      Labels: { [CACHE_LABEL]: "1", [PROJECT_LABEL]: projectId },
    });
  }
  const volume = await docker.getVolume(name).inspect();
  if (cacheOwner(volume) !== projectId)
    throw new AppError(
      "The build cache volume belongs to another owner",
      409,
      "BUILD_CACHE_OWNER_MISMATCH",
    );
  return reused;
}

/** Only complete, recognized inventory records authorize deletion. */
export interface ManagedBuildCache {
  name: string;
  projectId: string;
  bytes: number;
  references: number;
  createdAt: number;
}
export function managedBuildCaches(raw: unknown): ManagedBuildCache[] {
  const volumes = (raw as { Volumes?: unknown[] } | null)?.Volumes;
  if (volumes === null) return [];
  if (!Array.isArray(volumes)) throw new Error("Docker returned no build-cache volume inventory");
  return volumes.flatMap((value) => {
    const v = value as {
      Name?: string;
      Labels?: Record<string, string>;
      CreatedAt?: string;
      UsageData?: { Size?: number; RefCount?: number };
    };
    const projectId = cacheOwner(v);
    const size = v.UsageData?.Size;
    const refs = v.UsageData?.RefCount;
    if (
      !projectId ||
      !Number.isSafeInteger(size) ||
      size! < 0 ||
      !Number.isSafeInteger(refs) ||
      refs! < 0
    )
      return [];
    return [
      {
        name: v.Name!,
        projectId,
        bytes: size!,
        references: refs!,
        createdAt: Date.parse(v.CreatedAt ?? "") || 0,
      },
    ];
  });
}

/** Caller holds the SAME physical-host lock as worker bootstrap. Attached
 * workers pin their state in Docker, including after a lost control-plane reply.
 * No image, application volume, or another builder's state is a candidate. */
export async function pruneManagedBuildCaches(
  docker: CacheDocker,
  executor: CommandExecutor,
  options: {
    keepBytes?: number;
    /** Maintenance sweeps can spend longer measuring than build admission. */
    measurementTimeoutMs?: number;
    projectId?: string;
    now?: number;
    protectedProjectIds?: ReadonlySet<string>;
    protectAll?: boolean;
  } = {},
): Promise<{ cachesDeleted: string[]; spaceReclaimed: number }> {
  const requestedKeepBytes = options.keepBytes ?? DEFAULT_BUILD_CACHE_KEEP_BYTES;
  if (!Number.isSafeInteger(requestedKeepBytes) || requestedKeepBytes < 0)
    throw new RangeError("Invalid build-cache budget");
  // When admission is already blocked on storage, deferring a slow idle cache
  // guarantees another failed deployment. Give that measurement the same bounded
  // budget as explicit cleanup; healthy hosts keep the short best-effort scan.
  let storage = parseBuildStorage(await executor.exec(DOCKER_BUILD_STORAGE_COMMAND));
  const storageBlocked =
    storage.freeBytes < buildStorageReserve(storage) || storage.freeInodes === 0;
  const measurementTimeoutMs =
    options.projectId || requestedKeepBytes === 0
      ? 120_000
      : (options.measurementTimeoutMs ?? (storageBlocked ? 120_000 : 15_000));
  // A full /system/df also scans application/database volumes. Measure ONLY
  // recognized cache volumes so GC never walks a user's database to size caches.
  const inventory = await docker.listVolumes({ filters: { label: [`${CACHE_LABEL}=1`] } });
  const attached = await docker.listContainers({ all: true });
  const rows = await Promise.all(
    (inventory.Volumes ?? []).map(async (volume) => {
      const projectId = cacheOwner(volume);
      if (!projectId) return null;
      if (options.projectId && projectId !== options.projectId) return null;
      const references = attached.filter((container) =>
        container.Mounts?.some(
          (mount) => mount.Name === volume.Name || mount.Source === volume.Mountpoint,
        ),
      ).length;
      // Running BuildKit workers can delete files while du walks their state.
      // Protected state is outside this pass's reclaimable budget; size it only
      // after the worker and durable issuing commands have confirmed exit.
      if (references || options.protectAll || options.protectedProjectIds?.has(projectId))
        return { ...volume, UsageData: { Size: 0, RefCount: references } };
      if (!volume.Mountpoint?.startsWith("/"))
        throw new Error("Build-cache volume has no host storage path");
      let raw: string;
      try {
        raw = await executor.exec(`du -sk -- ${sq(volume.Mountpoint)}`, {
          timeout: measurementTimeoutMs,
        });
      } catch (error) {
        // Accounting is optional during automatic retention. A large idle cache
        // can take longer to walk than a command deadline; retain that volume
        // for a later sweep instead of failing an otherwise successful build.
        // Explicit removal and unconfirmed command exits remain failures.
        if (
          error instanceof Error &&
          error.name === "TimeoutError" &&
          !options.projectId &&
          requestedKeepBytes > 0
        ) {
          diagnostics.warn(
            "adapters/runtime/docker-build-cache",
            `Build-cache size inspection timed out for ${volume.Name}; retained for a later cleanup.`,
          );
          return null;
        }
        throw error;
      }
      const kb = Number(raw.trim().split(/\s+/)[0]);
      if (!Number.isSafeInteger(kb) || kb < 0 || !raw.trim())
        throw new Error("Could not measure build-cache volume size");
      return { ...volume, UsageData: { Size: kb * 1024, RefCount: references } };
    }),
  );
  const caches = managedBuildCaches({ Volumes: rows.filter(Boolean) });
  if (
    options.projectId &&
    (options.protectAll ||
      options.protectedProjectIds?.has(options.projectId) ||
      caches.some((cache) => cache.projectId === options.projectId && cache.references > 0))
  )
    throw new AppError("The project's build cache is still in use", 409, "BUILD_CACHE_IN_USE");
  let total = caches.reduce((sum, cache) => sum + cache.bytes, 0);
  // Other, attached builders can consume storage during a long measurement.
  storage = parseBuildStorage(await executor.exec(DOCKER_BUILD_STORAGE_COMMAND));
  const keepBytes = Math.min(requestedKeepBytes, buildCacheKeepBytes(storage));
  const idle = caches.filter(
    (cache) =>
      cache.references === 0 &&
      !options.protectAll &&
      !options.protectedProjectIds?.has(cache.projectId),
  );
  const ages = await Promise.all(
    idle.map(async (cache) => {
      const raw = await executor.exec(
        `if [ -f ${sq(stamp(cache.name))} ]; then stat -c %Y ${sq(stamp(cache.name))}; fi`,
      );
      const seconds = Number(raw.trim());
      return {
        ...cache,
        usedAt:
          raw.trim() && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : cache.createdAt,
      };
    }),
  );
  const result = { cachesDeleted: [] as string[], spaceReclaimed: 0 };
  for (const cache of ages.sort((a, b) => a.usedAt - b.usedAt || a.name.localeCompare(b.name))) {
    const expired = (options.now ?? Date.now()) - cache.usedAt > CACHE_AGE_MS;
    const pressure = storage.freeBytes < buildStorageReserve(storage) || storage.freeInodes === 0;
    if (
      options.projectId
        ? cache.projectId !== options.projectId
        : !expired && !pressure && total <= keepBytes
    )
      continue;
    // Recheck the owner immediately before remove. Docker's non-force delete
    // is the final in-use guard even if an external administrator attached it.
    const volume = await docker.getVolume(cache.name).inspect();
    if (cacheOwner(volume) !== cache.projectId)
      throw new AppError(
        "Build cache ownership changed during cleanup",
        409,
        "BUILD_CACHE_OWNER_MISMATCH",
      );
    try {
      await docker.getVolume(cache.name).remove();
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 409) {
        if (options.projectId)
          throw new AppError(
            "The project's build cache is still in use",
            409,
            "BUILD_CACHE_IN_USE",
          );
        continue;
      }
      if (!missing(error)) throw error;
    }
    total -= cache.bytes;
    result.cachesDeleted.push(cache.name);
    result.spaceReclaimed += cache.bytes;
    await executor.exec(`rm -f -- ${sq(stamp(cache.name))}`);
    storage = parseBuildStorage(await executor.exec(DOCKER_BUILD_STORAGE_COMMAND));
  }
  return result;
}

/** Touch only after worker attachment, under the bootstrap lock. */
export async function touchProjectBuildCache(
  executor: CommandExecutor,
  projectId: string,
): Promise<void> {
  await executor.exec(
    `mkdir -p ${sq(STAMPS)} && touch -- ${sq(stamp(projectBuildCacheVolume(projectId)))}`,
  );
}

export function buildKitCacheConfig(storage: BuildStorage): string {
  return `insecure-entitlements = []\n[worker.oci]\nnetworkMode = "bridge"\ngc = true\nreservedSpace = 0\nmaxUsedSpace = ${buildCacheKeepBytes(storage)}\nminFreeSpace = "${BUILD_STORAGE_GC_FREE_FRACTION * 100}%"\n`;
}
