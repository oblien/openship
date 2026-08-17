import type { Project } from "@repo/db";
import { resolveServicePort, type DeployableService } from "../../lib/deployable-service";
import { parseVolumeSpec } from "../services/volume-spec";

export type MountedReleaseBuildMode = "prebuilt" | "server" | "upload";

export interface MountedReleaseConfig {
  enabled: boolean;
  buildMode?: MountedReleaseBuildMode;
  runtimeInstall?: "image" | "dockerfile" | "compose";
  preset?: string;
  serviceId?: string;
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
  uid?: number;
  gid?: number;
}

export type MountedReleaseServiceRef = {
  id?: string;
  name: string;
  enabled?: boolean;
  exposedPort?: string | null;
  ports?: string[] | null;
};

/** Id wins when both sides have one; name only for legacy config or id-less snapshots. */
export function matchesMountedReleaseService(
  config: Pick<MountedReleaseConfig, "serviceId" | "serviceName">,
  service: MountedReleaseServiceRef,
): boolean {
  if (config.serviceId) {
    if (service.id) return service.id === config.serviceId;
    return Boolean(config.serviceName && service.name === config.serviceName);
  }
  return Boolean(config.serviceName && service.name === config.serviceName);
}

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

/** Empty list = single-app (primary). Otherwise require an enabled target row. */
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

export function mountedReleaseHealthPort(
  target:
    | { mode: "primary" }
    | { mode: "service"; service: Pick<MountedReleaseServiceRef, "exposedPort" | "ports"> },
  fallbackPort: number,
): number {
  if (target.mode !== "service") return fallbackPort;
  return resolveServicePort(target.service, fallbackPort) ?? fallbackPort;
}

export function mountedReleaseBuildMode(config: MountedReleaseConfig): MountedReleaseBuildMode {
  if (config.buildMode === "upload" || config.buildMode === "prebuilt" || config.buildMode === "server") {
    return config.buildMode;
  }
  return config.prepareCommand?.trim() ? "server" : "prebuilt";
}

export function mountedReleaseConfig(
  project: Pick<Project, "mountedRelease">,
): MountedReleaseConfig | null {
  const value = project.mountedRelease as MountedReleaseConfig | null;
  return value?.enabled ? value : null;
}

/** Active code-release row, or null when the project is runtime-only. */
export function activeCodeReleaseDeploymentId(
  project: Pick<Project, "mountedRelease" | "activeReleaseDeploymentId">,
): string | null {
  return mountedReleaseConfig(project) ? (project.activeReleaseDeploymentId ?? null) : null;
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

/** Container-side dest of a compose volume spec (`src:dest[:mode]`). */
export function volumeMountTarget(spec: string): string | null {
  return parseVolumeSpec(spec).target;
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

/** Attach the release-root mount only to the selected service. */
export function withMountedReleaseServiceVolume(
  project: Pick<Project, "id" | "mountedRelease">,
  services: DeployableService[],
): DeployableService[] {
  const config = mountedReleaseConfig(project);
  const mount = mountedReleaseVolume(project);
  if (!config || !mount || (!config.serviceId && !config.serviceName)) return services;
  return services.map((service) => {
    if (!matchesMountedReleaseService(config, service)) return service;
    const volumes = service.volumes ?? [];
    if (volumes.includes(mount)) return { ...service, volumes };
    const colliding = destCollision(volumes, config.containerPath);
    if (colliding) throw new BindMountCollisionError(config.containerPath, colliding);
    return { ...service, volumes: [...volumes, mount] };
  });
}
