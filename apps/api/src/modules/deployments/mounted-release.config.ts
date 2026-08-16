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

export function withMountedReleaseVolume(
  project: Pick<Project, "id" | "mountedRelease">,
  volumes: string[],
): string[] {
  const mount = mountedReleaseVolume(project);
  return mount && !volumes.includes(mount) ? [...volumes, mount] : volumes;
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
  return services.map((service) =>
    service.name === config.serviceName
      ? {
          ...service,
          volumes: (service.volumes ?? []).includes(mount)
            ? (service.volumes ?? [])
            : [...(service.volumes ?? []), mount],
        }
      : service,
  );
}
