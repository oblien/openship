import { createHash } from "node:crypto";
import { posix } from "node:path";

export const CLOUD_DOCKER_ROUTE_ROOT = "/opt/openship/cloud-docker/routes";
const MOUNT_ROOT = "/opt/openship/cloud-docker/mounts";

/** Stable project storage within its selected managed server. */
export function cloudDockerProjectPaths(projectId: string) {
  const suffix = `/projects/${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
  return { routes: `${CLOUD_DOCKER_ROUTE_ROOT}${suffix}`, mounts: `${MOUNT_ROOT}${suffix}`, bare: `${MOUNT_ROOT}${suffix}/bare` };
}

/** Lexical ownership only; the runtime must also verify the existing realpath
 * before a mount reaches Docker, so a symlink cannot escape project storage. */
export function isCloudProjectMountSource(projectId: string, source: string): boolean {
  return !!projectId && posix.isAbsolute(source) &&
    posix.resolve(source).startsWith(`${cloudDockerProjectPaths(projectId).mounts}/`);
}
