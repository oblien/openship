import type { WorkspaceData, WorkspaceHandle } from "oblien";
import { cloudCpus, type ResourceConfig } from "../../types";
import { cloudWorkspaceStatus } from "./workspace-ready";

type WorkspaceResources = Pick<ResourceConfig, "cpuCores" | "memoryMb"> &
  Partial<Pick<ResourceConfig, "diskMb">>;

export function cloudWorkspaceHasResources(
  workspace: Pick<WorkspaceData, "resources">,
  expected: WorkspaceResources,
): boolean {
  const actual = workspace.resources;
  return (
    actual?.cpus === cloudCpus(expected.cpuCores) &&
    actual.memory_mb === expected.memoryMb &&
    (expected.diskMb === undefined || actual.disk_size_mb === expected.diskMb)
  );
}

/** A successful HTTP response can mean only that configuration was saved.
 * Require an applied change and read the allocation back before claiming the
 * runtime was resized. Callers retain ownership of readiness and restoration. */
export async function updateCloudWorkspaceResources(
  workspace: WorkspaceHandle,
  resources: WorkspaceResources,
  current?: WorkspaceData,
): Promise<void> {
  const before = current ?? (await workspace.get());
  if (before.id !== workspace.id)
    throw new Error("Cloud workspace identity changed before resizing");
  // A provider may report relaunched:false for a no-op. Do not request a
  // restart, or mislabel it as a failed resize, when allocation already matches.
  if (cloudWorkspaceHasResources(before, resources)) return;
  const result = await workspace.resources.update({
    cpus: cloudCpus(resources.cpuCores),
    memory_mb: resources.memoryMb,
    ...(resources.diskMb === undefined ? {} : { disk_size_mb: resources.diskMb }),
    apply: true,
  });
  if (
    result?.success !== true ||
    (result.relaunched === false && !["stopped", "paused", "suspended"].includes(cloudWorkspaceStatus(before))) ||
    result.pending_capacity_verification
  ) {
    throw new Error(
      "The Cloud resource change is still pending verification; retry once the provider confirms it",
    );
  }
  const applied = await workspace.get();
  if (applied.id !== workspace.id || !cloudWorkspaceHasResources(applied, resources)) {
    throw new Error(
      "The requested Cloud allocation was not applied. Check the workspace's current resources before retrying.",
    );
  }
}
