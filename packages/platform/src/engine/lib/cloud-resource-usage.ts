import type { ResourceUsageSample } from "@repo/contracts";
import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { openCloudWorkspaceExecutor, readCloudWorkspaceConnection } from "./cloud-workspace-host";
import { cloudWorkspaceStatus } from "@repo/adapters";
import { sampleServerUsage } from "./server-usage";

const nonnegative = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
const mb = (value: unknown) => {
  const bytes = nonnegative(value);
  return bytes === null ? null : bytes / 1048576;
};
const free = (used: number | null, total: number | null) =>
  used === null || total === null ? null : Math.max(0, total - used);

/** Provider metrics are actual quota-relative CPU and guest bytes, not credits,
 * allocation, Docker inventory, or an empty project's consumption. */
export function normalizeResourceUsage(raw: unknown): ResourceUsageSample {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid live resource usage sample");
  const value = raw as Record<string, unknown>;
  const byteTotal = mb(value.guestMemoryTotal);
  const kibTotal = nonnegative(value.guestMemoryTotalKiB);
  const memoryTotalMb =
    byteTotal !== null && byteTotal > 0
      ? byteTotal
      : kibTotal !== null && kibTotal > 0
        ? kibTotal / 1024
        : null;
  const kibUsed = nonnegative(value.guestMemoryUsedKiB);
  const guestUsed =
    byteTotal !== null && byteTotal > 0
      ? mb(value.guestMemoryUsed)
      : kibUsed === null
        ? null
        : kibUsed / 1024;
  // memoryUsedMB/memoryTotalMB describe the hypervisor process, including VM
  // overhead. They cannot stand in for the guest's RAM consumption or capacity.
  const memoryUsedMb =
    memoryTotalMb !== null && guestUsed !== null && guestUsed <= memoryTotalMb ? guestUsed : null;
  const diskTotal = mb(value.guestDiskTotal ?? value.guestDiskTotalBytes);
  const diskUsed = mb(value.guestDiskUsed ?? value.guestDiskUsedBytes);
  const diskTotalMb = diskTotal !== null && diskTotal > 0 ? diskTotal : null;
  const diskUsedMb =
    diskTotalMb !== null && diskUsed !== null && diskUsed <= diskTotalMb ? diskUsed : null;
  const cpuPercent = nonnegative(value.cpuUsage);
  if (cpuPercent === null && memoryUsedMb === null && diskUsedMb === null)
    throw new Error("Live resource usage is unavailable. Retry to reconnect.");
  return {
    measuredAt: new Date().toISOString(),
    cpuPercent,
    memoryUsedMb,
    memoryAvailableMb: free(memoryUsedMb, memoryTotalMb),
    diskUsedMb,
    diskTotalMb,
    diskAvailableMb: free(diskUsedMb, diskTotalMb),
  };
}

/** Read the persisted, owned host; never provision/resume it or use master
 * credentials for its stream. The outer operation reauthorizes every sample. */
export async function* streamCloudResourceUsage(
  organizationId: string,
  serverId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) throw new NotFoundError("Server", serverId);
  if (!server.workspaceId)
    throw new AppError(
      "Live resource usage is available for Cloud spaces only",
      409,
      "MANAGED_RESOURCE_REQUIRED",
    );
  const { client, binding, provider } = await readCloudWorkspaceConnection(
    organizationId,
    server.workspaceId,
  );
  signal?.throwIfAborted();
  if (!["running", "active"].includes(cloudWorkspaceStatus(provider.workspace)))
    throw new AppError(
      "This Cloud space is not running. Live usage is unavailable.",
      409,
      "CLOUD_WORKSPACE_NOT_RUNNING",
    );
  let executor: Awaited<ReturnType<typeof openCloudWorkspaceExecutor>> | undefined;
  let memorySample: Pick<ResourceUsageSample, "memoryUsedMb" | "memoryAvailableMb"> | undefined;
  let sampledAt = 0;
  try {
    for await (const raw of client.streamWorkspaceMetrics(binding.workspaceId!, signal)) {
      signal?.throwIfAborted();
      const sample = normalizeResourceUsage(raw);
      if (sample.memoryUsedMb === null || sample.memoryAvailableMb === null) {
        // Older guests do not publish memory telemetry. Use the same cheap
        // guest sample as HTTP, at most once per ten seconds per subscription.
        // This does not enumerate Docker storage, start the VM, or create data.
        if (!memorySample || Date.now() - sampledAt >= 10_000) {
          executor ??= await openCloudWorkspaceExecutor(organizationId, server.workspaceId);
          memorySample = await executor.runWithAbortSignal(
            signal ?? new AbortController().signal,
            () => sampleServerUsage(executor!),
          );
          sampledAt = Date.now();
        }
        Object.assign(sample, {
          memoryUsedMb: memorySample.memoryUsedMb,
          memoryAvailableMb: memorySample.memoryAvailableMb,
        });
      }
      signal?.throwIfAborted();
      yield { event: "usage", data: JSON.stringify(sample) };
    }
  } finally {
    await executor?.dispose();
  }
}
