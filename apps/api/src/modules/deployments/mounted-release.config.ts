import type { Project } from "@repo/db";
import type { DeployableService } from "../../lib/deployable-service";

export interface MountedReleaseConfig {
  enabled: boolean;
  buildMode?: "prebuilt" | "server";
  /** Persistent `service` row id. Preferred target for mount / reload / health. */
  serviceId?: string;
  /** Display name, and the only key on pre-serviceId rows. */
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

export type MountedReleaseServiceRef = {
  id?: string;
  name: string;
  enabled?: boolean;
};

/** True when this compose row is the configured mount target. */
export function matchesMountedReleaseService(
  config: Pick<MountedReleaseConfig, "serviceId" | "serviceName">,
  service: MountedReleaseServiceRef,
): boolean {
  if (config.serviceId) {
    if (service.id) return service.id === config.serviceId;
    // Raw compose-parse snapshots have no row id yet — name is the only key.
    return Boolean(config.serviceName && service.name === config.serviceName);
  }
  return Boolean(config.serviceName && service.name === config.serviceName);
}

/** Resolve the live service row a mounted release should target. */
export function mountedReleaseTargetService<T extends MountedReleaseServiceRef>(
  config: Pick<MountedReleaseConfig, "serviceId" | "serviceName">,
  services: T[],
): T | undefined {
  if (config.serviceId) {
    return services.find((service) => service.id === config.serviceId);
  }
  if (config.serviceName) {
    return services.find((service) => service.name === config.serviceName);
  }
  return undefined;
}

/**
 * Reload / health must hit this service's container — never the compose
 * primary. No service rows means a single-app project (primary is correct).
 */
export function resolveMountedReleaseRuntimeTarget<T extends MountedReleaseServiceRef>(
  config: Pick<MountedReleaseConfig, "serviceId" | "serviceName">,
  services: T[],
):
  | { ok: true; mode: "primary" }
  | { ok: true; mode: "service"; service: T }
  | { ok: false; reason: "missing" | "disabled" } {
  if (services.length === 0) return { ok: true, mode: "primary" };
  const service = mountedReleaseTargetService(config, services);
  if (!service) return { ok: false, reason: "missing" };
  if (service.enabled === false) return { ok: false, reason: "disabled" };
  return { ok: true, mode: "service", service };
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
 * missing target is valid for single-app projects, but never sprayed over
 * every service in a compose stack. Prefer serviceId; serviceName is only
 * for legacy rows and id-less parse snapshots. */
export function withMountedReleaseServiceVolume(
  project: Pick<Project, "id" | "mountedRelease">,
  services: DeployableService[],
): DeployableService[] {
  const config = mountedReleaseConfig(project);
  const mount = mountedReleaseVolume(project);
  if (!config || !mount || (!config.serviceId && !config.serviceName)) return services;
  return services.map((service) =>
    matchesMountedReleaseService(config, service)
      ? {
          ...service,
          volumes: (service.volumes ?? []).includes(mount)
            ? (service.volumes ?? [])
            : [...(service.volumes ?? []), mount],
        }
      : service,
  );
}
