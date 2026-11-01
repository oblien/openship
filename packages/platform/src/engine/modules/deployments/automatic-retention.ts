import type { Project } from "@repo/db";
import { BUILD_STORAGE_GC_FREE_FRACTION } from "@repo/adapters";
import { isArtifactRef, usableRef } from "../../lib/container-ref";
import { hasRedactedFrozenConfiguration } from "./compose/redacted-frozen-env";
import { planRestore } from "./rollback/restore-plan";
import { retainedArtifactReferences, type retainedArtifacts } from "./retained-artifacts";

type Inventory = Awaited<ReturnType<typeof retainedArtifacts>>;
type Disk = { totalBytes: number | null; freeBytes: number | null };

export function rollbackStoragePressure(disk: Disk): boolean {
  return (
    disk.totalBytes !== null &&
    disk.freeBytes !== null &&
    Number.isSafeInteger(disk.totalBytes) &&
    disk.totalBytes > 0 &&
    Number.isSafeInteger(disk.freeBytes) &&
    disk.freeBytes >= 0 &&
    disk.freeBytes <= disk.totalBytes &&
    disk.freeBytes < disk.totalBytes * BUILD_STORAGE_GC_FREE_FRACTION
  );
}

export interface AutomaticRetentionDependencies {
  /** Fresh measurement of the selected runtime's filesystem; unknown preserves artifacts. */
  readDisk(): Promise<Disk>;
  load(): Promise<Inventory>;
  ownedImages(): Promise<ReadonlySet<string>>;
  purge(inventory: Inventory): Promise<{ purged: number; failed: number }>;
}

/** Caller holds the existing retention/admission lock for the entire operation.
 * Reuse its purge path, and measure actual free space after each release instead
 * of pretending Docker's shared image sizes are reclaimable bytes. */
export async function reclaimAutomaticRollbackArtifacts(
  project: Project,
  deps: AutomaticRetentionDependencies,
): Promise<{ purged: number; failed: number }> {
  const summary = { purged: 0, failed: 0 };
  if (project.rollbackWindow != null || !project.activeDeploymentId) return summary;
  if (!rollbackStoragePressure(await deps.readDisk())) return summary;
  const inventory = await deps.load();
  const ownedImages = await deps.ownedImages();
  const discarded = new Set<string>();
  for (const candidate of [...inventory.retained].reverse()) {
    if (
      !candidate.artifactRetainedAt ||
      candidate.pinned ||
      candidate.id === project.activeDeploymentId ||
      candidate.status === "reconciling"
    )
      continue;
    if (hasRedactedFrozenConfiguration(candidate.meta)) continue;
    const plan = planRestore({
      target: candidate,
      project,
      unitRestore: false,
      imagePresent: () => false,
      pathPresent: () => false,
      serviceImages: (inventory.services.get(candidate.id) ?? []).map((row) => ({
        serviceName: row.serviceName ?? null,
        imageRef: row.imageRef,
      })),
    });
    const frozen = candidate.meta as {
      repoUrl?: string;
      localPath?: string;
      uploadSessionId?: string;
    } | null;
    const reproducible =
      plan.mode === "rebuild"
        ? !!frozen?.repoUrl && !frozen.localPath && !frozen.uploadSessionId
        : plan.mode === "reacquire-image" && /@sha256:[a-f0-9]{64}$/.test(plan.releaseImageRef);
    if (!reproducible) continue;
    const candidateArtifacts = [candidate, ...(inventory.services.get(candidate.id) ?? [])];
    if (
      !candidateArtifacts.some((row) => {
        const image = usableRef(row.imageRef);
        return image && (ownedImages.has(image) || isArtifactRef(image));
      }) &&
      !isArtifactRef(candidate.containerId)
    )
      continue;

    discarded.add(candidate.id);
    // Keep legacy/unmeasured history protected too; an absent archive marker
    // alone is not proof that its last usable artifact is gone.
    const retained = inventory.retained.filter((dep) => !discarded.has(dep.id));
    const refs = await retainedArtifactReferences(
      retained,
      async (id) => inventory.services.get(id) ?? [],
    );
    // Automatic cleanup never stops/removes a container. A stopped container
    // still referencing an image makes Docker refuse removal; keep it retryable.
    // Only project-label-verified images and managed release files are candidates.
    for (const dep of inventory.retained) {
      for (const artifact of [dep, ...(inventory.services.get(dep.id) ?? [])]) {
        const image = usableRef(artifact.imageRef);
        const container = usableRef(artifact.containerId);
        if (image && !isArtifactRef(image) && !ownedImages.has(image)) refs.images.add(image);
        if (container && !isArtifactRef(container)) refs.containers.add(container);
      }
      for (const role of dep.roleContainers ?? []) {
        const container = usableRef(role.containerId);
        if (container) refs.containers.add(container);
      }
    }
    const result = await deps.purge({
      ...refs,
      retained,
      overflow: [candidate],
    });
    if (!result.purged && !result.failed) {
      // The destination changed or could not be verified: preserve its refs.
      discarded.delete(candidate.id);
      continue;
    }
    summary.purged += result.purged;
    summary.failed += result.failed;
    if (result.failed || !rollbackStoragePressure(await deps.readDisk())) break;
  }
  return summary;
}
