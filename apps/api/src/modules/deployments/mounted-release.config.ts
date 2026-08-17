import type { Project } from "@repo/db";
import type { DeployableService } from "../../lib/deployable-service";

export interface MountedReleaseConfig {
  enabled: boolean;
  buildMode?: "prebuilt" | "server";
  serviceName?: string;
  sourcePath?: string;
  containerPath: string;
  sharedPaths?: string[];
  prepareCommand?: string;
  builderImage?: string;
  builderMemoryMb?: number;
  builderCpus?: number;
  builderCachePaths?: string[];
  reloadCommand?: string;
  healthPath?: string;
  healthPort?: number;
  retain?: number;
}

export function mountedReleaseBuildMode(config: MountedReleaseConfig): "prebuilt" | "server" {
  return config.buildMode ?? (config.prepareCommand?.trim() ? "server" : "prebuilt");
}

export function mountedReleaseConfig(
  project: Pick<Project, "mountedRelease">,
): MountedReleaseConfig | null {
  const value = project.mountedRelease as MountedReleaseConfig | null;
  return value?.enabled ? value : null;
}

export function mountedReleaseHostRoot(projectId: string): string {
  return `/var/lib/openship/mounted-releases/${projectId}`;
}

export function mountedReleaseVolume(
  project: Pick<Project, "id" | "mountedRelease">,
): string | null {
  const config = mountedReleaseConfig(project);
  return config ? `${mountedReleaseHostRoot(project.id)}:${config.containerPath}` : null;
}

/** Compose bind-mode suffix — same set the volume namespacer recognises. */
const VOLUME_MODE_SUFFIX = /:(ro|rw|z|Z|nocopy)$/i;

/** Container-side dest of a compose volume spec (`src:dest[:mode]`). */
export function volumeMountTarget(spec: string): string | null {
  const body = spec.trim().replace(VOLUME_MODE_SUFFIX, "");
  if (!body) return null;
  const idx = body.lastIndexOf(":");
  if (idx < 0) return body.startsWith("/") ? body : null;
  const dest = body.slice(idx + 1);
  return dest || null;
}

export function normalizeMountPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(/\/+$/, "") || "/";
}

export class BindMountCollisionError extends Error {
  constructor(
    public readonly containerPath: string,
    public readonly existing: string,
  ) {
    super(
      `Mounted release path ${containerPath} is already bound by ${JSON.stringify(existing)}. ` +
        `Change containerPath or remove that mount — Docker cannot attach two binds to the same destination.`,
    );
    this.name = "BindMountCollisionError";
  }
}

function destCollision(volumes: string[], dest: string): string | undefined {
  const want = normalizeMountPath(dest);
  return volumes.find((spec) => {
    const target = volumeMountTarget(spec);
    return target != null && normalizeMountPath(target) === want;
  });
}

export function withMountedReleaseVolume(
  project: Pick<Project, "id" | "mountedRelease">,
  volumes: string[],
): string[] {
  const config = mountedReleaseConfig(project);
  const mount = mountedReleaseVolume(project);
  if (!config || !mount) return volumes;
  if (volumes.includes(mount)) return volumes;
  const colliding = destCollision(volumes, config.containerPath);
  if (colliding) throw new BindMountCollisionError(config.containerPath, colliding);
  return [...volumes, mount];
}

/** Add the stable release-root mount only to the selected compose service. A
 * missing serviceName is valid for single-app projects, but never sprayed over
 * every service in a compose stack. */
export function withMountedReleaseServiceVolume(
  project: Pick<Project, "id" | "mountedRelease">,
  services: DeployableService[],
): DeployableService[] {
  const config = mountedReleaseConfig(project);
  const mount = mountedReleaseVolume(project);
  if (!config || !mount || !config.serviceName) return services;
  return services.map((service) => {
    if (service.name !== config.serviceName) return service;
    const volumes = service.volumes ?? [];
    if (volumes.includes(mount)) return { ...service, volumes };
    const colliding = destCollision(volumes, config.containerPath);
    if (colliding) throw new BindMountCollisionError(config.containerPath, colliding);
    return { ...service, volumes: [...volumes, mount] };
  });
}
