import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AppError, isHostPathSource } from "@repo/core";
import { cloudDockerProjectPaths, ensureScopedVolumeName, scopedVolumeName } from "@repo/adapters";
import { repos } from "@repo/db";
import { isMovableBind } from "./migration-preflight";
import type { DiscoveredVolumeMount } from "./docker-reconcile";

/** One destination map for both direct and streamed copies, and their resume
 * records. Managed imports never write a caller-supplied absolute host path. */
export function migrationTargetPath(projectId: string, source: string, managed: boolean): string {
  if (!managed) return source;
  const path = posix.normalize(source);
  const root = cloudDockerProjectPaths(projectId).mounts;
  if (path.startsWith(`${root}/`)) return path;
  return `${root}/imports/${createHash("sha256").update(path).digest("hex").slice(0, 32)}/${posix.basename(path) || "data"}`;
}

export function migrationTargetVolume(slug: string, source: string, managed: boolean, action?: "override" | "clone" | "keep") {
  return managed ? ensureScopedVolumeName(slug, source) : action === "clone" ? scopedVolumeName(slug, source) : source;
}

/** Persist the same mount names the transfer writes before a managed deploy
 * validates them. Source rows and sibling projects are never edited by an import. */
export async function scopeImportedStorage(projectId: string, managed: boolean, liveMounts?: ReadonlyMap<string, DiscoveredVolumeMount[]>, sameServer = false) {
  if (!managed && !liveMounts?.size) return;
  const project = sameServer ? await repos.project.findById(projectId) : null;
  if (sameServer && !project) throw new Error("Migration project is unavailable");
  const services = await repos.service.listByProject(projectId);
  const rewrite = (spec: string, copied: boolean) => {
    const parts = spec.split(":");
    if (parts.length > 1 && isHostPathSource(parts[0]!)) {
      if (managed && !isMovableBind(parts[0]!)) throw new AppError(
        `This service depends on the host mount ${parts[0]}. Remove that mount before importing it into a managed server.`,
        400, "MIGRATION_HOST_MOUNT_UNSUPPORTED");
      parts[0] = migrationTargetPath(projectId, parts[0]!, managed);
    } else if (parts.length > 1 && copied && sameServer) {
      // Match the transfer's explicit copy name, even if the foreign source
      // already looks namespaced. Anonymous live mounts become named copies.
      parts[0] = scopedVolumeName(project!.slug, parts[0]!);
    }
    return parts.join(":");
  };
  // Validate every row before writing any of them.
  const updates = services.map(service => {
    const resolved = liveMounts?.get(service.name);
    // Attach-live services stay on their original mounts. Only the copy set
    // has data written to a new destination on a same-server migration.
    if (sameServer && !resolved) return null;
    // Docker's resolved mounts include anonymous volumes and absolute bind
    // paths. Use them for the first target deploy as well as the data copy.
    const volumes = resolved ? resolved.filter(mount => mount.source)
      .map(mount => `${mount.source}:${mount.target}${mount.rw ? "" : ":ro"}`) : service.volumes ?? [];
    return { id: service.id, volumes: volumes.map(spec => rewrite(spec, !!resolved)), namespaceVolumes: managed || (resolved ? false : service.namespaceVolumes) };
  });
  for (const update of updates)
    if (update) await repos.service.update(update.id, { volumes: update.volumes, namespaceVolumes: update.namespaceVolumes });
}
