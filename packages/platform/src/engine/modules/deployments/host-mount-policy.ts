import { CloudDockerRuntime, type RuntimeAdapter } from "@repo/adapters";
import { AppError, findHostMountVolumes, hasRelativeVolumeMounts } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config";
import { instanceAuthorization } from "../../lib/instance-authorization";

function hasRestrictedMounts(
  volumes: readonly string[] | null | undefined,
  repositoryMounts: boolean,
): boolean {
  return findHostMountVolumes(volumes).some(
    (volume) => !repositoryMounts || !hasRelativeVolumeMounts([volume]),
  );
}

/** Runs in shared operations, so HTTP, MCP and native SDK writes agree. */
export async function assertHostMountWriteAccess(
  ctx: ExecutionContext,
  input: {
    volumes?: readonly string[] | null;
    services?: readonly { volumes?: readonly string[] | null }[] | null;
  },
): Promise<void> {
  if (
    !hasRestrictedMounts(input.volumes, env.CLOUD_MODE) &&
    !input.services?.some((service) => hasRestrictedMounts(service.volumes, env.CLOUD_MODE))
  )
    return;
  await instanceAuthorization.assert(ctx, "write");
}

/** Check authored mounts before appending platform-generated config-file binds.
 * Background deploys also consume repositories, old rows and restored snapshots;
 * request authorization alone cannot protect that boundary. An operator opting
 * in explicitly trusts every deployment author on this instance with host access.
 * Only CloudDockerRuntime may resolve repository mounts: it copies from prepared
 * source into project-owned storage and checks traversal and symlink containment.
 * CLOUD_MODE alone must never grant that exception to an ordinary Docker target. */
export function assertDeployVolumePolicy(
  volumes?: readonly string[] | null,
  runtime?: RuntimeAdapter,
): void {
  const managedRepositoryMounts = runtime instanceof CloudDockerRuntime;
  if (!hasRestrictedMounts(volumes, managedRepositoryMounts)) return;
  const cloud = env.CLOUD_MODE || managedRepositoryMounts;
  if (!cloud && process.env.OPENSHIP_ALLOW_HOST_BIND_MOUNTS === "true") return;
  throw new AppError(
    cloud
      ? "Host bind mounts are disabled in Cloud. Use named volumes or relative repository paths on a managed Docker target."
      : "Host bind mounts are disabled. Use named volumes, or ask the instance operator to enable OPENSHIP_ALLOW_HOST_BIND_MOUNTS on an instance with trusted deployment authors.",
    403,
    "HOST_MOUNT_FORBIDDEN",
  );
}
