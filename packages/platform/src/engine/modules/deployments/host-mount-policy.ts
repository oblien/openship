import { AppError, findHostMountVolumes } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config";
import { instanceAuthorization } from "../../lib/instance-authorization";

/** Runs in shared operations, so HTTP, MCP and native SDK writes agree. */
export async function assertHostMountWriteAccess(
  ctx: ExecutionContext,
  input: {
    volumes?: readonly string[] | null;
    services?: readonly { volumes?: readonly string[] | null }[] | null;
  },
): Promise<void> {
  if (
    findHostMountVolumes(input.volumes).length === 0 &&
    !input.services?.some((service) => findHostMountVolumes(service.volumes).length > 0)
  )
    return;
  await instanceAuthorization.assert(ctx, "write");
}

/** Check authored mounts before appending platform-generated config-file binds.
 * Background deploys also consume repositories, old rows and restored snapshots;
 * request authorization alone cannot protect that boundary. An operator opting
 * in explicitly trusts every deployment author on this instance with host access. */
export function assertDeployVolumePolicy(volumes?: readonly string[] | null): void {
  if (findHostMountVolumes(volumes).length === 0) return;
  if (!env.CLOUD_MODE && process.env.OPENSHIP_ALLOW_HOST_BIND_MOUNTS === "true") return;
  throw new AppError(
    "Host bind mounts are disabled. Use named volumes, or ask the instance operator to enable OPENSHIP_ALLOW_HOST_BIND_MOUNTS on an instance with trusted deployment authors.",
    403,
    "HOST_MOUNT_FORBIDDEN",
  );
}
